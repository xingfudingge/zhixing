//! 原生 OCR：macOS Apple Vision 接入。
//!
//! 背景：macOS Tauri 使用 WKWebView，而 WebKit 的 Shape Detection
//! (`TextDetector`) 默认关闭（WebKit `UnifiedWebPreferences.yaml` 中
//! `ShapeDetection.status = testable`、`defaultValue = false`）。因此不能把
//! “WebView 没有 TextDetector”当作“系统没有 OCR”。
//!
//! 本模块通过 Tauri command 调用 Apple Vision：
//! - 能力探测：`VNRecognizeTextRequest::supportedRecognitionLanguages...`
//! - 识别：`VNImageRequestHandler` + `VNRecognizeTextRequest`
//! - 图片经 ImageIO 解码为 `CGImage`，限制字节数与像素数后再交给 Vision
//!
//! 硬约束：
//! - 所有处理都在本机完成，不发起任何网络请求；Vision 是本地框架，
//!   不需要相册 TCC 权限（`Permission` 阶段保留给未来平台接入）；
//! - 失败按阶段返回（输入/解码/语言/架构/请求），不 blanket catch；
//! - 识别结果只来自 Vision 的 observation，不生成占位文字；
//! - 不把图片字节、临时路径或识别文本写入日志。

use serde::Serialize;

/// 单张图片的字节上限：20 MiB。超过时不解码，直接返回输入错误。
pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// 解码后的像素上限：4000 万像素。避免超大图占满内存。
pub const MAX_IMAGE_PIXELS: u64 = 40_000_000;

/// 引擎展示名。前端 `NativeVisionEngine` 也使用这个名字。
pub const ENGINE_NAME: &str = "Apple Vision";

/// OCR 失败阶段。前端据此区分“输入/解码/语言/架构/请求”失败。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OcrStage {
    Input,
    Decode,
    Permission,
    Language,
    Architecture,
    Request,
}

/// 结构化 OCR 错误。Tauri 会把它序列化后作为 `invoke` 的 reject 值返回。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrFailure {
    pub stage: OcrStage,
    /// 机器可读的具体原因，例如 `empty_image`、`unsupported_language`。
    pub code: String,
    /// 面向用户的真实原因；不得包含图片字节或识别文本。
    pub message: String,
}

impl OcrFailure {
    pub fn new(stage: OcrStage, code: &str, message: impl Into<String>) -> Self {
        Self {
            stage,
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub fn input(code: &str, message: impl Into<String>) -> Self {
        Self::new(OcrStage::Input, code, message)
    }

    pub fn decode(code: &str, message: impl Into<String>) -> Self {
        Self::new(OcrStage::Decode, code, message)
    }

    pub fn language(code: &str, message: impl Into<String>) -> Self {
        Self::new(OcrStage::Language, code, message)
    }

    pub fn architecture(code: &str, message: impl Into<String>) -> Self {
        Self::new(OcrStage::Architecture, code, message)
    }

    pub fn request(code: &str, message: impl Into<String>) -> Self {
        Self::new(OcrStage::Request, code, message)
    }
}

/// 能力探测结果；字段名与前端 `NativeOcrCapability` 对齐。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrCapability {
    pub available: bool,
    pub engine_name: String,
    pub languages: Vec<String>,
    pub version: Option<String>,
    pub reason: Option<String>,
}

/// 识别文本块。`bounding_box` 为 0..1 归一化坐标，原点在左上角。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrBlock {
    pub text: String,
    pub confidence: f32,
    pub bounding_box: OcrBoundingBox,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrBoundingBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 真实识别结果；字段名与前端 `NativeOcrResult` 对齐。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrRecognizeResponse {
    pub text: String,
    /// Vision 不直接返回检测到的语言；这里保持 null，由调用方展示请求语言。
    pub language: Option<String>,
    pub confidence: Option<f32>,
    pub blocks: Vec<OcrBlock>,
    pub duration_ms: u64,
    pub engine_name: String,
    /// 实际传给 Vision 的 BCP-47 语言（按请求顺序去重）。
    pub languages: Vec<String>,
    pub image_width: u32,
    pub image_height: u32,
}

/// 应用内语言 ID → Vision 支持的 BCP-47。
///
/// 设置只允许 `zh-Hans` / `zh-Hant` / `en` / `ja`；这里同时接受
/// 常见 BCP-47 写法，便于直接调用和测试。
pub fn vision_language(app_language: &str) -> Option<&'static str> {
    match app_language.trim().to_ascii_lowercase().as_str() {
        "zh-hans" | "zh-cn" | "zh-sg" => Some("zh-Hans"),
        "zh-hant" | "zh-tw" | "zh-hk" | "zh-mo" => Some("zh-Hant"),
        "en" | "en-us" | "en-gb" => Some("en-US"),
        "ja" | "ja-jp" => Some("ja-JP"),
        _ => None,
    }
}

/// Vision 支持的 BCP-47 → 应用内语言 ID。
pub fn app_language(vision_language: &str) -> Option<&'static str> {
    let normalized = vision_language.trim().to_ascii_lowercase();
    if normalized == "zh-hans" || normalized.starts_with("zh-hans") {
        Some("zh-Hans")
    } else if normalized == "zh-hant" || normalized.starts_with("zh-hant") {
        Some("zh-Hant")
    } else if normalized == "en-us" || normalized.starts_with("en-") || normalized == "en" {
        Some("en")
    } else if normalized == "ja-jp" || normalized.starts_with("ja-") || normalized == "ja" {
        Some("ja")
    } else {
        None
    }
}

/// 把设置里的语言转换为 Vision BCP-47；未知语言返回 `Language` 阶段错误。
pub fn requested_vision_languages(languages: &[String]) -> Result<Vec<String>, OcrFailure> {
    let mut mapped = Vec::new();
    for language in languages {
        let Some(code) = vision_language(language) else {
            return Err(OcrFailure::language(
                "unsupported_language",
                format!("不支持的识别语言：{language}。可选语言为 zh-Hans、zh-Hant、en、ja。"),
            ));
        };
        if !mapped
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(code))
        {
            mapped.push(code.to_string());
        }
    }
    Ok(mapped)
}

/// 把 Vision 实际支持的语言与应用请求求交；有任一请求语言不支持就报错。
pub fn validate_supported_languages(
    requested: &[String],
    supported: &[String],
) -> Result<Vec<String>, OcrFailure> {
    let mut missing = Vec::new();
    for language in requested {
        if !supported
            .iter()
            .any(|item| item.eq_ignore_ascii_case(language))
        {
            missing.push(language.clone());
        }
    }
    if !missing.is_empty() {
        let supported_app: Vec<&str> = supported
            .iter()
            .filter_map(|language| app_language(language))
            .collect();
        let supported_text = if supported_app.is_empty() {
            "无法读取当前识别级别的支持语言".to_string()
        } else {
            supported_app.join("、")
        };
        return Err(OcrFailure::language(
            "unsupported_language",
            format!(
                "Apple Vision 当前不支持识别语言：{}。当前可用：{}。",
                missing.join("、"),
                supported_text
            ),
        ));
    }
    Ok(requested.to_vec())
}

/// 输入字节校验：空图与超大图都在解码前拒绝。
pub fn validate_image_bytes(bytes: &[u8]) -> Result<(), OcrFailure> {
    if bytes.is_empty() {
        return Err(OcrFailure::input(
            "empty_image",
            "图片为空，无法识别；不会生成占位文字。",
        ));
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(OcrFailure::input(
            "image_too_large",
            format!(
                "图片过大（{} 字节），超过 {} 字节上限，未解码。",
                bytes.len(),
                MAX_IMAGE_BYTES
            ),
        ));
    }
    Ok(())
}

/// 解码后的尺寸校验：0 宽高或超过像素上限都明确失败。
pub fn validate_image_dimensions(width: usize, height: usize) -> Result<(), OcrFailure> {
    if width == 0 || height == 0 {
        return Err(OcrFailure::decode(
            "empty_pixels",
            "图片解码后宽或高为 0，无法识别。",
        ));
    }
    let pixels = (width as u64).saturating_mul(height as u64);
    if pixels > MAX_IMAGE_PIXELS {
        return Err(OcrFailure::input(
            "image_too_many_pixels",
            format!(
                "图片像素过多（{}×{} = {} 像素），超过 {} 像素上限，未交给 Vision。",
                width, height, pixels, MAX_IMAGE_PIXELS
            ),
        ));
    }
    Ok(())
}

/// Vision 原始 observation（归一化坐标、原点左下）。
#[derive(Debug, Clone, PartialEq)]
pub struct RawObservation {
    pub text: String,
    pub confidence: f32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn clamp_unit(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// Vision 的 boundingBox 原点在左下；前端统一用左上。
pub fn top_left_box(x: f64, y: f64, width: f64, height: f64) -> OcrBoundingBox {
    OcrBoundingBox {
        x: clamp_unit(x),
        y: clamp_unit(1.0 - (y + height)),
        width: clamp_unit(width),
        height: clamp_unit(height),
    }
}

/// 把 observation 映射成文本块、整段文本和字符数加权置信度。
///
/// 不补全空文本：只有 Vision 返回非空 string 的 observation 才进入 blocks。
pub fn map_observations(raw: Vec<RawObservation>) -> (String, Option<f32>, Vec<OcrBlock>) {
    let blocks: Vec<OcrBlock> = raw
        .into_iter()
        .filter_map(|observation| {
            let text = observation.text.trim().to_string();
            if text.is_empty() {
                return None;
            }
            Some(OcrBlock {
                text,
                confidence: clamp_unit(observation.confidence as f64) as f32,
                bounding_box: top_left_box(
                    observation.x,
                    observation.y,
                    observation.width,
                    observation.height,
                ),
            })
        })
        .collect();

    if blocks.is_empty() {
        return (String::new(), None, blocks);
    }

    let total_chars: f64 = blocks
        .iter()
        .map(|block| block.text.chars().count() as f64)
        .sum();
    let confidence = if total_chars > 0.0 {
        let weighted: f64 = blocks
            .iter()
            .map(|block| (block.confidence as f64) * (block.text.chars().count() as f64))
            .sum();
        Some(clamp_unit(weighted / total_chars) as f32)
    } else {
        None
    };

    let text = blocks
        .iter()
        .map(|block| block.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    (text, confidence, blocks)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::AnyObject;
    use objc2::AnyThread;
    use objc2_core_foundation::CFData;
    use objc2_core_graphics::CGImage;
    use objc2_foundation::{NSArray, NSDictionary, NSProcessInfo, NSString};
    use objc2_image_io::CGImageSource;
    use objc2_vision::{
        VNImageOption, VNImageRequestHandler, VNRecognizeTextRequest, VNRequest,
        VNRequestTextRecognitionLevel,
    };
    use std::time::Instant;

    // 类方法是 Apple 标记 deprecated 的旧 API，但它从 macOS 10.15 起可用；
    // 新实例方法要 macOS 12+。这里保留旧 API 以兼容 Tauri 支持的低版本 macOS。
    #[allow(deprecated)]
    fn supported_languages(request: &VNRecognizeTextRequest) -> Result<Vec<String>, OcrFailure> {
        // 使用 macOS 10.15 起可用的类方法，并按请求当前 revision 查询；
        // 避免 macOS 12 才提供的实例方法在更旧系统上不可用。
        // SAFETY: 调用 Vision 的公开 Objective-C 方法；返回值由 Vision 持有，
        // 这里立即复制为 Rust String，不跨 autoreleasepool 保存。
        let revision = unsafe { request.revision() };
        let languages = unsafe {
            VNRecognizeTextRequest::supportedRecognitionLanguagesForTextRecognitionLevel_revision_error(
                VNRequestTextRecognitionLevel::Accurate,
                revision,
            )
        }
        .map_err(|error| {
            OcrFailure::architecture(
                "vision_languages_failed",
                format!(
                    "Apple Vision 无法读取支持语言：{}",
                    error.localizedDescription()
                ),
            )
        })?;
        Ok(languages.iter().map(|value| value.to_string()).collect())
    }

    fn supported_app_languages(supported: &[String]) -> Vec<String> {
        let mut languages = Vec::new();
        for app_language_id in ["zh-Hans", "zh-Hant", "en", "ja"] {
            let Some(vision_code) = vision_language(app_language_id) else {
                continue;
            };
            if supported
                .iter()
                .any(|item| item.eq_ignore_ascii_case(vision_code))
            {
                languages.push(app_language_id.to_string());
            }
        }
        languages
    }

    pub fn capability() -> OcrCapability {
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        let (languages, language_error) = match supported_languages(&request) {
            Ok(supported) => (supported_app_languages(&supported), None),
            Err(failure) => (Vec::new(), Some(failure.message)),
        };
        let version = Some(
            NSProcessInfo::processInfo()
                .operatingSystemVersionString()
                .to_string(),
        );
        OcrCapability {
            available: true,
            engine_name: ENGINE_NAME.to_string(),
            languages,
            version,
            reason: language_error,
        }
    }

    pub fn recognize(
        bytes: &[u8],
        languages: &[String],
    ) -> Result<OcrRecognizeResponse, OcrFailure> {
        validate_image_bytes(bytes)?;
        // 语言错误先于解码返回：坏图 + 坏语言时，用户先看到语言问题。
        let requested = requested_vision_languages(languages)?;
        let started = Instant::now();

        autoreleasepool(|_| {
            let request = VNRecognizeTextRequest::new();
            request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
            request.setUsesLanguageCorrection(true);
            // 不调用 automaticallyDetectsLanguage：该 API 需要 macOS 13，
            // 设置页始终至少有一种语言；空列表交给 Vision 的默认语言即可。
            let recognized_languages = if requested.is_empty() {
                Vec::new()
            } else {
                let supported = supported_languages(&request)?;
                let validated = validate_supported_languages(&requested, &supported)?;
                let ns_languages: Vec<Retained<NSString>> = validated
                    .iter()
                    .map(|language| NSString::from_str(language))
                    .collect();
                request.setRecognitionLanguages(&NSArray::from_retained_slice(&ns_languages));
                validated
            };

            // ImageIO 先解码并给出真实像素尺寸；失败直接报解码阶段。
            let data = CFData::from_bytes(bytes);
            // SAFETY: data 在调用期间保持存活；options 为空字典。
            let source = unsafe { CGImageSource::with_data(&data, None) }.ok_or_else(|| {
                OcrFailure::decode(
                    "unsupported_image",
                    "无法解码图片：文件不是受支持的图片格式（PNG/JPEG/HEIC 等）。",
                )
            })?;
            // SAFETY: source 在调用期间保持存活。
            if unsafe { source.count() } == 0 {
                return Err(OcrFailure::decode(
                    "empty_image_source",
                    "图片解码失败：文件中没有可读取的图像帧。",
                ));
            }
            // SAFETY: 索引 0 已在上面通过 count 校验。
            let image = unsafe { source.image_at_index(0, None) }.ok_or_else(|| {
                OcrFailure::decode(
                    "image_decode_failed",
                    "图片解码失败：ImageIO 无法生成位图，文件可能损坏。",
                )
            })?;
            let width = CGImage::width(Some(&image));
            let height = CGImage::height(Some(&image));
            validate_image_dimensions(width, height)?;

            let options = NSDictionary::<VNImageOption, AnyObject>::new();
            // SAFETY: image 与 options 在 handler 生命周期内保持存活；
            // handler 只读取图片，不修改内容。
            let handler = unsafe {
                VNImageRequestHandler::initWithCGImage_options(
                    VNImageRequestHandler::alloc(),
                    &image,
                    &options,
                )
            };
            let request_ref: &VNRequest = &request;
            let requests = NSArray::from_slice(&[request_ref]);
            handler.performRequests_error(&requests).map_err(|error| {
                OcrFailure::request(
                    "vision_request_failed",
                    format!("Apple Vision 识别失败：{}", error.localizedDescription()),
                )
            })?;

            let raw: Vec<RawObservation> = match request.results() {
                Some(results) => {
                    let mut observations = Vec::new();
                    for observation in results.iter() {
                        let Some(candidate) = observation.topCandidates(1).firstObject() else {
                            continue;
                        };
                        // SAFETY: observation 来自本次请求的结果数组，调用期间存活。
                        let bounding_box = unsafe { observation.boundingBox() };
                        observations.push(RawObservation {
                            text: candidate.string().to_string(),
                            confidence: candidate.confidence(),
                            x: bounding_box.origin.x,
                            y: bounding_box.origin.y,
                            width: bounding_box.size.width,
                            height: bounding_box.size.height,
                        });
                    }
                    observations
                }
                // Vision 文档：请求失败时 results 为 nil；无文字时应为空数组。
                // 不能把 nil 当成“空文本成功”，否则会伪造成功结果。
                None => {
                    return Err(OcrFailure::request(
                        "vision_results_missing",
                        "Apple Vision 未返回识别结果；请求可能失败，未生成任何文本。",
                    ))
                }
            };
            let (text, confidence, blocks) = map_observations(raw);

            Ok(OcrRecognizeResponse {
                text,
                language: None,
                confidence,
                blocks,
                duration_ms: started.elapsed().as_millis() as u64,
                engine_name: ENGINE_NAME.to_string(),
                languages: recognized_languages,
                image_width: width.min(u32::MAX as usize) as u32,
                image_height: height.min(u32::MAX as usize) as u32,
            })
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    pub fn capability() -> OcrCapability {
        OcrCapability {
            available: false,
            engine_name: "系统本地 OCR".to_string(),
            languages: Vec::new(),
            version: None,
            reason: Some(
                "当前平台未接入原生 OCR：桌面端仅 macOS 使用 Apple Vision；Windows 需后续接入 Windows.Media.Ocr。"
                    .to_string(),
            ),
        }
    }

    pub fn recognize(
        _bytes: &[u8],
        _languages: &[String],
    ) -> Result<OcrRecognizeResponse, OcrFailure> {
        Err(OcrFailure::architecture(
            "platform_unsupported",
            "当前平台没有可用的原生 OCR 实现；仅 macOS Apple Vision 已接入。",
        ))
    }
}

/// 能力探测（非 Tauri 环境也可直接调用，便于测试）。
pub fn capability() -> OcrCapability {
    platform::capability()
}

/// 真实识别（非 Tauri 环境也可直接调用，便于测试）。
pub fn recognize(bytes: &[u8], languages: &[String]) -> Result<OcrRecognizeResponse, OcrFailure> {
    platform::recognize(bytes, languages)
}

/// 前端能力探测命令。`ocr_probe` 为同名别名，便于按“probe”语义调用。
#[tauri::command]
pub fn ocr_capability() -> OcrCapability {
    capability()
}

#[tauri::command]
pub fn ocr_probe() -> OcrCapability {
    capability()
}

/// 前端识别命令：输入图片字节与语言 ID，返回真实 Vision 结果。
///
/// 同步 Vision 调用放到 Tauri 阻塞线程池，避免卡住 WebView 主线程。
#[tauri::command]
pub async fn ocr_recognize(
    image_bytes: Vec<u8>,
    languages: Vec<String>,
) -> Result<OcrRecognizeResponse, OcrFailure> {
    tauri::async_runtime::spawn_blocking(move || recognize(&image_bytes, &languages))
        .await
        .map_err(|error| {
            OcrFailure::request("ocr_task_failed", format!("OCR 任务执行失败：{error}"))
        })?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_bytes() -> Vec<u8> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("ocr-sample.png");
        std::fs::read(&path)
            .unwrap_or_else(|error| panic!("读取测试图片失败 {}：{error}", path.display()))
    }

    #[test]
    fn language_mapping_covers_settings_values() {
        assert_eq!(vision_language("zh-Hans"), Some("zh-Hans"));
        assert_eq!(vision_language("zh-Hant"), Some("zh-Hant"));
        assert_eq!(vision_language("en"), Some("en-US"));
        assert_eq!(vision_language("ja"), Some("ja-JP"));
        assert_eq!(vision_language("xx"), None);
        assert_eq!(app_language("zh-Hans"), Some("zh-Hans"));
        assert_eq!(app_language("en-US"), Some("en"));
        assert_eq!(app_language("ja-JP"), Some("ja"));
        assert_eq!(app_language("ko-KR"), None);
    }

    #[test]
    fn requested_languages_are_deduplicated_and_unknown_is_rejected() {
        assert_eq!(
            requested_vision_languages(&[
                "zh-Hans".to_string(),
                "en".to_string(),
                "en-US".to_string(),
            ])
            .expect("known languages"),
            vec!["zh-Hans".to_string(), "en-US".to_string()]
        );
        let failure = requested_vision_languages(&["xx".to_string()]).expect_err("unknown");
        assert_eq!(failure.stage, OcrStage::Language);
        assert_eq!(failure.code, "unsupported_language");
        assert!(failure.message.contains("xx"));
    }

    #[test]
    fn unsupported_vision_language_is_reported_with_available_list() {
        let supported = vec![
            "en-US".to_string(),
            "zh-Hans".to_string(),
            "ja-JP".to_string(),
        ];
        assert_eq!(
            validate_supported_languages(&["en-US".to_string()], &supported).expect("supported"),
            vec!["en-US".to_string()]
        );
        let failure = validate_supported_languages(&["zh-Hant".to_string()], &supported)
            .expect_err("missing");
        assert_eq!(failure.stage, OcrStage::Language);
        assert!(failure.message.contains("zh-Hant"));
        assert!(failure.message.contains("zh-Hans"));
    }

    #[test]
    fn empty_and_oversized_images_fail_before_decode() {
        let empty = validate_image_bytes(&[]).expect_err("empty");
        assert_eq!(empty.stage, OcrStage::Input);
        assert_eq!(empty.code, "empty_image");
        assert!(empty.message.contains("占位文字"));

        let too_large = vec![0u8; MAX_IMAGE_BYTES + 1];
        let failure = validate_image_bytes(&too_large).expect_err("too large");
        assert_eq!(failure.stage, OcrStage::Input);
        assert_eq!(failure.code, "image_too_large");

        let pixels = validate_image_dimensions(10_000, 10_000).expect_err("too many pixels");
        assert_eq!(pixels.code, "image_too_many_pixels");
        assert_eq!(
            validate_image_dimensions(0, 10)
                .expect_err("zero width")
                .code,
            "empty_pixels"
        );
    }

    #[test]
    fn observation_mapping_converts_box_origin_and_keeps_real_text() {
        let (text, confidence, blocks) = map_observations(vec![
            RawObservation {
                text: "ZHIXING".to_string(),
                confidence: 0.9,
                x: 0.1,
                y: 0.2,
                width: 0.5,
                height: 0.1,
            },
            RawObservation {
                text: "  ".to_string(),
                confidence: 0.99,
                x: 0.0,
                y: 0.0,
                width: 0.1,
                height: 0.1,
            },
            RawObservation {
                text: "OCR".to_string(),
                confidence: 0.7,
                x: 0.1,
                y: 0.5,
                width: 0.2,
                height: 0.1,
            },
        ]);
        assert_eq!(text, "ZHIXING\nOCR");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].bounding_box.y, 0.7);
        assert!((blocks[0].bounding_box.y - 0.7).abs() < 1e-9);
        let weighted = (0.9 * 7.0 + 0.7 * 3.0) / 10.0;
        assert!((confidence.expect("confidence") - weighted).abs() < 1e-6);
    }

    #[test]
    fn empty_observations_do_not_invent_text() {
        let (text, confidence, blocks) = map_observations(Vec::new());
        assert_eq!(text, "");
        assert_eq!(confidence, None);
        assert!(blocks.is_empty());
    }

    #[test]
    fn failure_serializes_with_stage_and_code() {
        let value = serde_json::to_value(OcrFailure::language("unsupported_language", "不支持"))
            .expect("serialize");
        assert_eq!(value["stage"], "language");
        assert_eq!(value["code"], "unsupported_language");
        assert_eq!(value["message"], "不支持");
    }

    #[test]
    fn empty_image_and_unsupported_language_are_real_errors_on_all_platforms() {
        let empty = recognize(&[], &["en".to_string()]).expect_err("empty image");
        assert_eq!(empty.stage, OcrStage::Input);
        assert_eq!(empty.code, "empty_image");

        #[cfg(target_os = "macos")]
        {
            let unsupported =
                recognize(b"not an image", &["xx".to_string()]).expect_err("bad language");
            assert_eq!(unsupported.stage, OcrStage::Language);
            assert_eq!(unsupported.code, "unsupported_language");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_capability_reports_apple_vision() {
        let capability = capability();
        assert!(capability.available, "{capability:?}");
        assert_eq!(capability.engine_name, "Apple Vision");
        assert!(capability.version.is_some());
        assert!(capability.languages.iter().any(|value| value == "en"));
        assert!(capability.languages.iter().any(|value| value == "zh-Hans"));
        assert_eq!(capability.reason, None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn tauri_capability_command_wrapper_reports_apple_vision() {
        // 直接调用注册到 generate_handler! 的命令包装，确认桌面壳 probe 的返回。
        let capability = ocr_capability();
        assert!(capability.available);
        assert_eq!(capability.engine_name, "Apple Vision");
        assert_eq!(ocr_probe().engine_name, "Apple Vision");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_recognizes_real_image_text() {
        let result = recognize(&fixture_bytes(), &["en".to_string(), "zh-Hans".to_string()])
            .expect("real Vision recognition");
        println!("Vision text: {:?}", result.text);
        println!("Vision blocks: {}", result.blocks.len());
        println!("Vision confidence: {:?}", result.confidence);
        assert_eq!(result.engine_name, "Apple Vision");
        assert_eq!(result.image_width, 1600);
        assert_eq!(result.image_height, 500);
        assert!(!result.blocks.is_empty());
        assert!(result.confidence.is_some());
        let upper = result.text.to_ascii_uppercase();
        assert!(upper.contains("ZHIXING"), "{}", result.text);
        assert!(upper.contains("OCR"), "{}", result.text);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_bad_image_reports_decode_stage() {
        let failure = recognize(b"this is not an image", &["en".to_string()])
            .expect_err("bad image must fail");
        assert_eq!(failure.stage, OcrStage::Decode);
        assert!(failure.message.contains("解码"), "{}", failure.message);
    }
}
