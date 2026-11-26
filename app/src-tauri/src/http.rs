//! 受限 HTTP 传输（ICS 只读订阅 + 节假日内置源）。
//!
//! 为什么不在 WebView 里直接 `fetch`：
//! - 生产 CSP 的 `connect-src` 只允许 IPC，直接请求会被拦（ZX12-AUDIT-01 R1）；
//! - 条件请求头 `If-None-Match` / `If-Modified-Since` 会触发 CORS 预检，
//!   不少订阅源（含 jsDelivr）不允许，第二次同步必失败（R2）；
//! - 跨域 304 响应经常缺少 `Access-Control-Allow-Origin`（R4）。
//!
//! 节假日同步（ZX12-FIX-304-01）与 ICS 共用本命令：三个内置源都经 IPC
//! 拉取，条件头真实到达源，304 原样回传，不再用镜像 200 冒充“未变化”。
//!
//! 本命令只做“用户明确订阅/内置源配置的只读日历拉取”，不是通用代理：
//! - 只允许 http/https，拒绝 URL 内嵌账号密码；
//! - 只转发 `accept` / `if-none-match` / `if-modified-since` 三个请求头；
//! - 固定 GET、整体超时、最多 5 次重定向、响应体上限 16 MiB；
//! - 只回传前端需要的响应头（ETag / Last-Modified / Content-Type），
//!   不把 `set-cookie` 等敏感头带进渲染层；
//! - 错误信息包含可诊断的失败类别，但不记录/回传 URL 中的 token。

use std::collections::BTreeMap;
use std::io::Read;
use std::time::Duration;

const DEFAULT_TIMEOUT_MS: u64 = 20_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_REDIRECTS: u32 = 5;
const ALLOWED_HEADERS: [&str; 3] = ["accept", "if-none-match", "if-modified-since"];

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpFetchResponse {
    pub status: u16,
    pub status_text: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_type: Option<String>,
    pub body: String,
    pub final_url: String,
}

/// 前端唯一入口：在阻塞线程池执行网络 IO，避免卡住 WebView/主线程。
#[tauri::command]
pub async fn http_fetch_text(
    url: String,
    headers: Option<BTreeMap<String, String>>,
    timeout_ms: Option<u64>,
) -> Result<HttpFetchResponse, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_text_blocking(&url, headers, timeout_ms))
        .await
        .map_err(|error| format!("网络请求线程异常：{error}"))?
}

fn validate_fetch_url(raw: &str) -> Result<url::Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("日历地址为空".to_string());
    }
    let url = url::Url::parse(trimmed).map_err(|error| format!("日历地址不是合法 URL：{error}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("只允许 http/https 日历地址，收到 {other}")),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("日历地址不能内嵌账号密码；请使用只含订阅 token 的 URL".to_string());
    }
    if url.host_str().is_none() {
        return Err("日历地址缺少主机名".to_string());
    }
    Ok(url)
}

fn sanitize_headers(
    input: Option<BTreeMap<String, String>>,
) -> Result<Vec<(String, String)>, String> {
    let mut headers = Vec::new();
    for (name, value) in input.unwrap_or_default() {
        let lower = name.trim().to_ascii_lowercase();
        if !ALLOWED_HEADERS.contains(&lower.as_str()) {
            return Err(format!("不允许的请求头：{name}"));
        }
        if value.contains('\r') || value.contains('\n') {
            return Err(format!("请求头 {name} 含有非法换行"));
        }
        headers.push((lower, value));
    }
    Ok(headers)
}

fn source_is_timeout(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = error.source();
    while let Some(source) = current {
        if let Some(io_error) = source.downcast_ref::<std::io::Error>() {
            if matches!(
                io_error.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            ) {
                return true;
            }
        }
        let text = source.to_string().to_ascii_lowercase();
        if text.contains("timed out") || text.contains("timeout") || text.contains("超时") {
            return true;
        }
        current = source.source();
    }
    false
}

fn map_transport_error(error: ureq::Transport) -> String {
    let detail = error.message().unwrap_or("").trim().to_string();
    let suffix = if detail.is_empty() {
        String::new()
    } else {
        format!("：{detail}")
    };
    let lower = detail.to_ascii_lowercase();
    let timed_out =
        lower.contains("timed out") || lower.contains("timeout") || detail.contains("超时")
            || source_is_timeout(&error);
    match error.kind() {
        ureq::ErrorKind::Dns => format!("桌面网络代理 DNS 解析失败{suffix}"),
        ureq::ErrorKind::ConnectionFailed => {
            format!("桌面网络代理连接失败（检查网络、代理或证书）{suffix}")
        }
        ureq::ErrorKind::TooManyRedirects => {
            format!("桌面网络代理重定向次数过多（最多 {MAX_REDIRECTS} 次）")
        }
        ureq::ErrorKind::InvalidUrl | ureq::ErrorKind::UnknownScheme => {
            format!("桌面网络代理地址无效{suffix}")
        }
        ureq::ErrorKind::ProxyConnect
        | ureq::ErrorKind::ProxyUnauthorized
        | ureq::ErrorKind::InvalidProxyUrl => format!("桌面网络代理配置错误{suffix}"),
        ureq::ErrorKind::Io => {
            if timed_out {
                format!("桌面网络代理请求超时{suffix}")
            } else {
                format!("桌面网络代理网络错误{suffix}")
            }
        }
        other => format!("桌面网络代理失败（{other}）{suffix}"),
    }
}

fn fetch_text_blocking(
    raw_url: &str,
    headers: Option<BTreeMap<String, String>>,
    timeout_ms: Option<u64>,
) -> Result<HttpFetchResponse, String> {
    let url = validate_fetch_url(raw_url)?;
    let headers = sanitize_headers(headers)?;
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );
    let agent = ureq::AgentBuilder::new()
        .timeout(timeout)
        .redirects(MAX_REDIRECTS)
        .user_agent(concat!("Zhixing/", env!("CARGO_PKG_VERSION")))
        .build();
    let mut request = agent.request("GET", url.as_str());
    for (name, value) in &headers {
        request = request.set(name, value);
    }

    // ureq 把 >=400 视为 Error::Status；这里仍然返回状态码，让前端给出
    // “HTTP 500/404”这种可操作文案，而不是笼统的“请求失败”。
    let response = match request.call() {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(ureq::Error::Transport(error)) => return Err(map_transport_error(error)),
    };

    let status = response.status();
    let status_text = response.status_text().to_string();
    let etag = response.header("etag").map(ToString::to_string);
    let last_modified = response.header("last-modified").map(ToString::to_string);
    let content_type = response.header("content-type").map(ToString::to_string);
    let final_url = response.get_url().to_string();

    let body = if status == 304 || status == 204 {
        String::new()
    } else {
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take((MAX_BODY_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("读取日历响应失败：{error}"))?;
        if bytes.len() > MAX_BODY_BYTES {
            return Err(format!(
                "日历响应超过 {} MiB 上限，已停止读取",
                MAX_BODY_BYTES / 1024 / 1024
            ));
        }
        String::from_utf8_lossy(&bytes).into_owned()
    };

    Ok(HttpFetchResponse {
        status,
        status_text,
        etag,
        last_modified,
        content_type,
        body,
        final_url,
    })
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    fn serve_once(status: &'static str, headers: &'static str, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server addr");
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0_u8; 4096];
                let _ = stream.read(&mut request);
                let response =
                    format!("HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = stream.write_all(response.as_bytes());
            }
        });
        format!("http://{address}/calendar.ics")
    }

    #[test]
    fn rejects_non_http_and_embedded_credentials() {
        assert!(validate_fetch_url("file:///etc/passwd").is_err());
        assert!(validate_fetch_url("ftp://example.com/a.ics").is_err());
        assert!(validate_fetch_url("https://user:secret@example.com/a.ics").is_err());
        assert!(validate_fetch_url("https://example.com/a.ics").is_ok());
    }

    #[test]
    fn only_forwards_conditional_request_headers() {
        let mut headers = BTreeMap::new();
        headers.insert("If-None-Match".to_string(), "\"v1\"".to_string());
        headers.insert("If-Modified-Since".to_string(), "Mon, 26 Oct 2026 10:00:00 GMT".to_string());
        headers.insert("Accept".to_string(), "text/calendar".to_string());
        assert_eq!(sanitize_headers(Some(headers)).expect("allowed").len(), 3);

        let mut forbidden = BTreeMap::new();
        forbidden.insert("authorization".to_string(), "Bearer secret".to_string());
        let error = sanitize_headers(Some(forbidden)).expect_err("reject auth header");
        assert!(error.contains("不允许的请求头"));
    }

    #[test]
    fn fetches_body_and_etag_from_local_server() {
        let url = serve_once("200 OK", "ETag: \"v1\"\r\nContent-Type: text/calendar\r\n", "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
        let result = fetch_text_blocking(&url, None, Some(5_000)).expect("fetch local");
        assert_eq!(result.status, 200);
        assert_eq!(result.etag.as_deref(), Some("\"v1\""));
        assert_eq!(result.body, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    }

    #[test]
    fn returns_status_instead_of_generic_error_for_http_500() {
        let url = serve_once("500 Internal Server Error", "", "boom");
        let result = fetch_text_blocking(&url, None, Some(5_000)).expect("status response");
        assert_eq!(result.status, 500);
    }

    fn read_request_headers(stream: &mut std::net::TcpStream) -> String {
        let mut data = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    data.extend_from_slice(&buffer[..count]);
                    if data.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&data).to_string()
    }

    #[test]
    fn forwards_conditional_header_and_returns_real_304() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind conditional server");
        let address = listener.local_addr().expect("conditional server addr");
        let server = thread::spawn(move || {
            for index in 0..2 {
                let (mut stream, _) = listener.accept().expect("accept conditional request");
                let request = read_request_headers(&mut stream);
                let lower = request.to_ascii_lowercase();
                if index == 0 {
                    assert!(!lower.contains("if-none-match"));
                    let body = "{\"year\":2026}";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nETag: \"holiday-v1\"\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(response.as_bytes()).expect("write 200");
                } else {
                    assert!(
                        lower.contains("if-none-match: \"holiday-v1\""),
                        "second request did not forward If-None-Match: {request}"
                    );
                    stream
                        .write_all(
                            b"HTTP/1.1 304 Not Modified\r\nETag: \"holiday-v1\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        )
                        .expect("write 304");
                }
            }
        });

        let url = format!("http://{address}/holiday.json");
        let first = fetch_text_blocking(&url, None, Some(5_000)).expect("first fetch");
        assert_eq!(first.status, 200);
        assert_eq!(first.etag.as_deref(), Some("\"holiday-v1\""));

        let mut headers = BTreeMap::new();
        headers.insert(
            "If-None-Match".to_string(),
            first.etag.clone().expect("first etag"),
        );
        let second =
            fetch_text_blocking(&url, Some(headers), Some(5_000)).expect("second fetch");
        assert_eq!(second.status, 304);
        assert_eq!(second.body, "");
        assert_eq!(second.etag.as_deref(), Some("\"holiday-v1\""));
        server.join().expect("conditional server join");
    }

    #[test]
    fn returns_304_with_empty_body() {
        let url = serve_once("304 Not Modified", "ETag: \"v2\"\r\n", "");
        let result = fetch_text_blocking(&url, None, Some(5_000)).expect("304 response");
        assert_eq!(result.status, 304);
        assert_eq!(result.body, "");
        assert_eq!(result.etag.as_deref(), Some("\"v2\""));
    }

    /// 手动网络探针（默认忽略）：
    /// cargo test ... http::tests::real_source_conditional_probe -- --ignored --nocapture
    #[test]
    #[ignore = "manual network probe"]
    fn real_source_conditional_probe() {
        let cases = [
            "https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2026.json",
            "https://cdn.jsdelivr.net/npm/chinese-days@1.5.9/dist/years/2026.json",
            "https://cdn.jsdelivr.net/gh/Lancetwang/china-mainland-calendar@main/china-mainland.ics",
        ];
        for url in cases {
            let started = std::time::Instant::now();
            let first = match fetch_text_blocking(url, None, Some(15_000)) {
                Ok(response) => {
                    println!(
                        "{url} first -> {} etag={:?} elapsed={:?}",
                        response.status,
                        response.etag,
                        started.elapsed()
                    );
                    response
                }
                Err(error) => {
                    println!("{url} first -> ERROR {error} elapsed={:?}", started.elapsed());
                    continue;
                }
            };
            let Some(etag) = first.etag else {
                println!("{url} -> no ETag, skip conditional probe");
                continue;
            };
            let mut headers = BTreeMap::new();
            headers.insert("If-None-Match".to_string(), etag);
            let started = std::time::Instant::now();
            let result = fetch_text_blocking(url, Some(headers), Some(15_000));
            match result {
                Ok(response) => println!(
                    "{url} second -> {} etag={:?} elapsed={:?}",
                    response.status,
                    response.etag,
                    started.elapsed()
                ),
                Err(error) => println!("{url} second -> ERROR {error} elapsed={:?}", started.elapsed()),
            }
        }
    }

    #[test]
    fn reports_timeout_with_specific_message() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind slow server");
        let address = listener.local_addr().expect("slow server addr");
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0_u8; 4096];
                let _ = stream.read(&mut request);
                thread::sleep(Duration::from_millis(1_500));
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
            }
        });
        let url = format!("http://{address}/slow.ics");
        let error = fetch_text_blocking(&url, None, Some(MIN_TIMEOUT_MS)).expect_err("timeout");
        assert!(error.contains("超时"), "unexpected timeout message: {error}");
    }
}
