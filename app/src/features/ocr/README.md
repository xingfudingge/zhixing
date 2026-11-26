# 图片 OCR（AUD-007 / P2-03）

默认关闭；只有真实引擎返回的结果才会展示。没有引擎时显示“不可用/未配置”，
不会生成示例文字、随机文本或“识别成功”占位。

## 设置页入口

`设置 → 知识库与 OCR` 直接挂载 `OcrPanel`，提供：

- 总开关（默认关闭）、识别范围（仅新图片 / 全部图片 / 指定目录）、语言与引擎；
- 系统本地引擎能力探测、自定义适配器端点与“允许远程处理图片”确认；
- 测试图片识别：调用当前引擎真实识别，返回原始文本或真实错误；
- 数据去向：图片是否离开设备、识别文本只存本机还是进入同步队列；
- 识别队列状态、按范围排队、处理队列、重试/取消。

开关、范围、目录、语言、引擎与端点保存在 `localStorage` 键 `zhixing.ocr.v1`，
重新加载后保持；端点不会保存账号密码。

### 识别范围（真实入队 gate）

| 范围 | 入队行为 |
|---|---|
| 仅新图片 | 还没有识别记录的图片正常入队；已有作业直接复用原结果；强制重跑或换了引擎/内容会抛 `OcrScopeError`。 |
| 全部图片 | 允许覆盖已有结果重新识别；同一附件/引擎/图片仍只保留一个作业。 |
| 指定目录 | 只处理选定知识库目录内笔记下的图片。未选目录、无法确认目录、目录不匹配都拒绝入队，并给出具体原因。 |

“指定目录”指知识库目录（`notes.folder_id`，选项来自 `NOTE_FOLDERS`），
不扫描任意本机路径；目录选择写入 OCR 设备偏好，重启后保持。
“按范围排队”列出真实附件元数据并按上述规则入队；所选目录为空时返回
“所选目录没有可识别的图片”，不生成占位作业。

## 附件与图片块入口

`AttachmentPanel` 的每张本机图片、`ImageBlock` 的本机图片都会挂载
`OcrImageAction`。入口读取同一份 OCR 偏好：关闭时按钮禁用并提示去设置页
开启；指定目录未选目录时同样禁用并给出原因。开启后点击会读取本机原图、
按当前引擎/语言真实识别并展示结果或错误。图片远程上传与 OCR 远程发送是
两套独立确认，互不代替。

## 引擎

| 引擎 | 行为 |
|---|---|
| 系统本地 OCR（桌面） | Tauri command `ocr_capability` / `ocr_recognize` → macOS Apple Vision `VNRecognizeTextRequest`。真实返回文本、文本块、置信度与归一化 bbox；不联网。 |
| 系统本地 OCR（浏览器预览） | 浏览器提供 `TextDetector` 时用于预览；没有 Tauri 时明确显示“当前为浏览器预览，需桌面壳”，不误报“系统没有 OCR”。 |
| 自定义适配器 | `GET endpoint` 探测能力；`POST endpoint` 发送图片并读取 `{text, language?, blocks?}`。 |
| 不使用引擎 | 一律不可用。 |

### 原生 Apple Vision 命令

```text
ocr_capability() / ocr_probe()
→ { available, engineName: "Apple Vision", languages, version, reason }

ocr_recognize(imageBytes: number[], languages: string[])
→ { text, language, confidence, blocks, durationMs, engineName,
    languages, imageWidth, imageHeight }
```

- 语言映射：`zh-Hans`/`zh-Hant`/`en`/`ja` → Vision BCP-47；启动时用
  `supportedRecognitionLanguages...` 校验，不支持的语言返回 `language` 阶段错误。
- 限制：图片字节 ≤ 20 MiB、解码像素 ≤ 4000 万；空图/坏图/超大图在识别前拒绝。
- 错误：`{ stage, code, message }`，stage 为 `input/decode/permission/language/architecture/request`；
  不使用 blanket catch，不生成占位文本。
- 隐私：图片字节、临时路径与识别文本都不写入日志；Vision 在本机处理，不需要网络。
- 非 macOS：`ocr_capability` 返回 available=false 和明确原因；不伪造可用。

### 原生依赖（仅 macOS target）

| crate | 版本 | 许可证 | 用途 |
|---|---|---|---|
| `objc2` | 0.6 | Zlib OR Apache-2.0 OR MIT | Objective-C 运行时 |
| `objc2-foundation` | 0.3 | Zlib OR Apache-2.0 OR MIT | NSArray/NSString/NSProcessInfo |
| `objc2-core-foundation` | 0.3 | Zlib OR Apache-2.0 OR MIT | CFData/CFDictionary |
| `objc2-core-graphics` | 0.3 | Zlib OR Apache-2.0 OR MIT | CGImage |
| `objc2-image-io` | 0.3 | Zlib OR Apache-2.0 OR MIT | ImageIO 解码/像素尺寸 |
| `objc2-vision` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | Vision 请求与 observation |

构建/真实识别验证：`cargo test --manifest-path src-tauri/Cargo.toml ocr -- --nocapture`。
测试使用 `tests/fixtures/ocr-sample.png`（1600×500，文字 `ZHIXING OCR 2026`）真实调用 Vision。

自定义适配器协议：

```http
GET https://ocr.example.com/ocr
Accept: application/json
→ { "engine": { "name": "PaddleOCR 自建", "version": "2.7", "languages": ["zh-Hans"] } }

POST https://ocr.example.com/ocr
Content-Type: image/png
X-OCR-Language: zh-Hans,en
→ { "text": "…", "language": "zh-Hans", "confidence": 0.9,
    "blocks": [{ "text": "…", "confidence": 0.9, "boundingBox": {"x":0,"y":0,"width":10,"height":10} }] }
```

- 非本机端点（不是 localhost/127.0.0.1/::1/`.local`）只有在
  `custom.allowRemoteImages === true` 时才会收到图片；否则抛
  `OcrRemoteConsentError`，请求不会发出。
- 不保存密钥/令牌；端点内嵌账号密码会被归一化为空。
- 响应缺少 `text` 字段按协议错误处理，不补空字符串。

## 队列与文本

- `enabled=false` 时 `enqueue`/`processAll`/`recognizeTestImage` 都拒绝，不排任务。
- 去重键：`attachmentId + engineId + 图片 SHA-256`；成功作业重复入队幂等。
- 作业状态：待处理/识别中/已完成/失败/已取消；失败保留原始错误，可重试。
- 设置页“处理队列”通过 `OcrGroup` 注入的真实附件读取器打开本机原图；
  读取不到时作业写“找不到原图”，读取器抛错时保留原始原因，不会永久禁用按钮。
- 识别文本默认 `textStorage='local'`，只存本机 IndexedDB。
- `textStorage='sync'` 时，作业成功后才把文本写入现有同步 `outbox`：
  - 后台模式：`SyncEngine.enqueue`，实体 `ocr_text/<attachmentId>`；
  - WebDAV 模式：`WebDavSyncEngine.enqueue`，走同一个 `SyncStore`；
  - 仅本机/未配对/未配置 WebDAV 时，作业显示“同步入队失败”和具体原因；
    不会显示“已同步”，也不会静默丢弃。
- 同步范围：只上传识别文本、语言、引擎、来源 SHA-256 与附件 ID，不上传图片。
- 冲突：同一附件复用同一个实体 ID，字段级合并；多设备并发识别产生的差异
  进入现有同步冲突记录（设置 → 同步可见）。
- 隐私：同步文本可能暴露图片中的信息；默认仅本机，开启前 UI 明确提示。
- 关闭 OCR 后不再排新任务；历史文本按用户选择处理。

## 系统限制

`TextDetector` 在部分 WebView/浏览器不可用（WebKit 默认关闭 Shape Detection）。
桌面壳已接入 macOS Apple Vision；Windows 原生 OCR 尚未接入，`ocr_capability`
会明确返回不可用。浏览器预览不会把“WebView 没有 TextDetector”说成“系统没有 OCR”。

## 测试

```sh
pnpm --filter app test -- ocr
pnpm --filter app typecheck
cargo test --manifest-path src-tauri/Cargo.toml ocr -- --nocapture
# 真实桌面：目录选择、队列处理、sync 失败原因、重启持久化
node tests/e2e/zx11-ocr-fix-01-desktop.mjs
```
