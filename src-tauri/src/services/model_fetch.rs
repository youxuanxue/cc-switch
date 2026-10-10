//! 模型列表获取服务
//!
//! 通过供应商协议对应的模型端点获取可用模型列表。默认使用 OpenAI 兼容的
//! GET /v1/models；Gemini Native 使用 GET /v1beta/models，并保留 OpenAI
//! 兼容端点作为第三方聚合站的兜底。

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, USER_AGENT};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;

/// 获取到的模型信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedModel {
    pub id: String,
    pub owned_by: Option<String>,
}

/// 模型列表响应的兼容格式。
///
/// OpenAI/Anthropic 用 `data`；Gemini Native 用 `models[].name`；
/// 智谱等目录用 `models[].slug`（#7593，`models` 保持 Value 以免拖垮 data）。
#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Option<Vec<ModelEntry>>,
    models: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
    owned_by: Option<String>,
}

/// `models[]` 条目 id：`name`（去 models/ 前缀）→ `slug` → `id`；无法识别则跳过。
fn catalog_and_gemini_model_ids(models: Option<serde_json::Value>) -> Vec<String> {
    let Some(serde_json::Value::Array(entries)) = models else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|m| {
            if let Some(name) = m.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                return Some(name.strip_prefix("models/").unwrap_or(name).to_string());
            }
            ["slug", "id"]
                .iter()
                .find_map(|k| m.get(*k)?.as_str().filter(|s| !s.is_empty()))
                .map(str::to_string)
        })
        .collect()
}

const FETCH_TIMEOUT_SECS: u64 = 15;
const MAX_REQUEST_HEADERS: usize = 64;
const MAX_HEADER_NAME_BYTES: usize = 256;
const MAX_HEADER_VALUE_BYTES: usize = 16 * 1024;

/// 404/405 响应体截断长度：避免把几十 KB HTML 404 页整页保留到错误串里。
const ERROR_BODY_MAX_CHARS: usize = 512;

/// 已知的「Anthropic 协议兼容子路径」后缀；按长度降序，最长前缀优先匹配。
/// baseURL 命中这些后缀时，候选列表会追加「剥离后缀再拼 /v1/models / /models」的版本。
const KNOWN_COMPAT_SUFFIXES: &[&str] = &[
    "/api/claudecode",
    "/api/anthropic",
    "/apps/anthropic",
    "/api/coding",
    "/claudecode",
    "/anthropic",
    "/step_plan",
    "/coding",
    "/claude",
];

/// 获取供应商的可用模型列表
///
/// 按 API 协议生成候选端点并顺序尝试。
pub async fn fetch_models(
    base_url: &str,
    api_key: &str,
    is_full_url: bool,
    models_url_override: Option<&str>,
    user_agent: Option<HeaderValue>,
    api_format: Option<&str>,
    request_headers: Option<&BTreeMap<String, String>>,
) -> Result<Vec<FetchedModel>, String> {
    let candidates = build_models_url_candidates_for_format(
        base_url,
        is_full_url,
        models_url_override,
        api_format,
    )?;
    let client = crate::proxy::http_client::get();
    let mut last_err: Option<String> = None;
    let mut known_secrets = vec![api_key.to_string()];
    if let Some(request_headers) = request_headers {
        known_secrets.extend(request_headers.values().cloned());
    }

    for (index, url) in candidates.iter().enumerate() {
        // Gemini Native 使用 x-goog-api-key；若原生端点不存在，OpenAI 兼容
        // 兜底仍沿用此前的 Bearer 认证行为。
        let candidate_api_format = model_fetch_api_format_for_candidate(api_format, index);
        let headers = build_model_fetch_headers(
            api_key,
            candidate_api_format,
            user_agent.as_ref(),
            request_headers,
        )?;
        log::debug!(
            "[ModelFetch] Trying endpoint: {}",
            crate::url_for_log_with_secrets(url, &known_secrets)
        );
        let request = client
            .get(url)
            .headers(headers.clone())
            .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS));
        let response = match request.send().await {
            Ok(r) => r,
            Err(e) => {
                return Err(format!("Request failed: {e}"));
            }
        };

        let status = response.status();

        if status.is_success() {
            let resp: ModelsResponse = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse response: {e}"))?;
            return Ok(normalize_models_response(resp));
        }

        if status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED {
            let body = redact_model_fetch_error_body(
                response.text().await.unwrap_or_default(),
                &known_secrets,
            );
            last_err = Some(format!("HTTP {status}: {body}"));
            continue;
        }

        let body = redact_model_fetch_error_body(
            response.text().await.unwrap_or_default(),
            &known_secrets,
        );
        return Err(format!("HTTP {status}: {body}"));
    }

    Err(format!(
        "All candidates failed: {}",
        last_err.unwrap_or_else(|| "no candidates".to_string())
    ))
}

fn normalize_models_response(response: ModelsResponse) -> Vec<FetchedModel> {
    let mut models: Vec<FetchedModel> = response
        .data
        .unwrap_or_default()
        .into_iter()
        .map(|model| FetchedModel {
            id: model.id,
            owned_by: model.owned_by,
        })
        .chain(
            catalog_and_gemini_model_ids(response.models)
                .into_iter()
                .map(|id| FetchedModel {
                    id,
                    owned_by: None,
                }),
        )
        .filter(|model| !model.id.is_empty())
        .collect();

    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    models
}

fn model_fetch_api_format_for_candidate(
    api_format: Option<&str>,
    candidate_index: usize,
) -> Option<&str> {
    if api_format == Some("google-generative-ai") && candidate_index > 0 {
        None
    } else {
        api_format
    }
}

fn redact_model_fetch_error_body(body: String, known_secrets: &[String]) -> String {
    truncate_body(crate::redact_known_secrets_strict(&body, known_secrets))
}

fn build_model_fetch_headers(
    api_key: &str,
    api_format: Option<&str>,
    user_agent: Option<&HeaderValue>,
    request_headers: Option<&BTreeMap<String, String>>,
) -> Result<HeaderMap, String> {
    let custom_count = request_headers.map_or(0, BTreeMap::len);
    if api_key.is_empty() && custom_count == 0 {
        return Err("API Key or request headers are required to fetch models".to_string());
    }
    if custom_count > MAX_REQUEST_HEADERS {
        return Err(format!(
            "Too many model-fetch request headers (maximum {MAX_REQUEST_HEADERS})"
        ));
    }

    let mut headers = HeaderMap::new();
    if !api_key.is_empty() {
        let (name, value) = match api_format {
            Some("anthropic-messages") => (
                HeaderName::from_static("x-api-key"),
                HeaderValue::from_str(api_key)
                    .map_err(|error| format!("Invalid API Key header value: {error}"))?,
            ),
            Some("google-generative-ai") => (
                HeaderName::from_static("x-goog-api-key"),
                HeaderValue::from_str(api_key)
                    .map_err(|error| format!("Invalid API Key header value: {error}"))?,
            ),
            _ => (
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {api_key}"))
                    .map_err(|error| format!("Invalid API Key header value: {error}"))?,
            ),
        };
        headers.insert(name, value);
    }

    if let Some(user_agent) = user_agent {
        headers.insert(USER_AGENT, user_agent.clone());
    }

    if let Some(request_headers) = request_headers {
        for (raw_name, raw_value) in request_headers {
            let name = raw_name.trim();
            if name.is_empty() || name.len() > MAX_HEADER_NAME_BYTES {
                return Err(format!("Invalid model-fetch header name: {raw_name}"));
            }
            if raw_value.len() > MAX_HEADER_VALUE_BYTES {
                return Err(format!("Model-fetch header value is too large: {name}"));
            }
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|error| format!("Invalid model-fetch header name {name}: {error}"))?;
            let value = HeaderValue::from_str(raw_value)
                .map_err(|error| format!("Invalid model-fetch header value for {name}: {error}"))?;
            headers.insert(name, value);
        }
    }

    Ok(headers)
}

/// 构造「模型列表端点」的候选 URL 列表
///
/// 候选顺序：
/// 1. `models_url_override` 非空 → 只返回它
/// 2. baseURL 拼 `/v1/models`；若已以版本段 `/v{N}` 结尾（`/v1`、智谱
///    `/api/coding/paas/v4` 等），版本号已在路径里，改拼 `/models`
/// 3. 版本段非 `/v1`（如 `/v4`）时再追加 `/v1/models` 作为兜底次候选
/// 4. 若 baseURL 命中 [`KNOWN_COMPAT_SUFFIXES`]，剥离后缀再拼 `/v1/models`、`/models`
///
/// 结果已去重且保持首次出现顺序。
pub fn build_models_url_candidates(
    base_url: &str,
    is_full_url: bool,
    models_url_override: Option<&str>,
) -> Result<Vec<String>, String> {
    if let Some(raw) = models_url_override {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(vec![trimmed.to_string()]);
        }
    }

    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Base URL is empty".to_string());
    }

    let mut candidates: Vec<String> = Vec::new();

    if is_full_url {
        if let Some(idx) = trimmed.find("/v1/") {
            candidates.push(format!("{}/v1/models", &trimmed[..idx]));
        } else if let Some(idx) = trimmed.rfind('/') {
            let root = &trimmed[..idx];
            if root.contains("://") && root.len() > root.find("://").unwrap() + 3 {
                candidates.push(format!("{root}/v1/models"));
            }
        }
        if candidates.is_empty() {
            return Err("Cannot derive models endpoint from full URL".to_string());
        }
        return Ok(candidates);
    }

    // baseURL 已以版本段 /v{N} 结尾时（如 `/v1`、智谱 `/api/coding/paas/v4`），
    // OpenAI 惯例的模型端点是 `{base}/models`，不能再补 `/v1`
    // （否则 .../coding/paas/v4/v1/models → 404）。
    if ends_with_version_segment(trimmed) {
        candidates.push(format!("{trimmed}/models"));
        // 版本段非 /v1 时，保留旧的 /v1/models 作为兜底次候选（正确路径已在前）。
        if !trimmed.ends_with("/v1") {
            candidates.push(format!("{trimmed}/v1/models"));
        }
    } else {
        candidates.push(format!("{trimmed}/v1/models"));
    }

    if let Some(stripped) = strip_compat_suffix(trimmed) {
        let root = stripped.trim_end_matches('/');
        if !root.is_empty() && root.contains("://") {
            candidates.push(format!("{root}/v1/models"));
            candidates.push(format!("{root}/models"));
        }
    }

    Ok(deduplicate_urls(candidates))
}

/// Gemini Native 优先使用 `/v1beta/models`（或已带版本段时的 `/models`），
/// 再追加 OpenAI 兼容候选，兼容同时服务多种协议的第三方聚合商。
fn build_models_url_candidates_for_format(
    base_url: &str,
    is_full_url: bool,
    models_url_override: Option<&str>,
    api_format: Option<&str>,
) -> Result<Vec<String>, String> {
    if api_format != Some("google-generative-ai")
        || models_url_override.is_some_and(|url| !url.trim().is_empty())
    {
        return build_models_url_candidates(base_url, is_full_url, models_url_override);
    }

    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Base URL is empty".to_string());
    }

    let native_endpoint = if is_full_url {
        if let Some(index) = trimmed.find("/v1beta/") {
            format!("{}/v1beta/models", &trimmed[..index])
        } else if let Some(index) = trimmed.find("/v1/") {
            format!("{}/v1beta/models", &trimmed[..index])
        } else if let Some(index) = trimmed.rfind('/') {
            let root = &trimmed[..index];
            if root.contains("://") && root.len() > root.find("://").unwrap() + 3 {
                format!("{root}/v1beta/models")
            } else {
                return Err("Cannot derive models endpoint from full URL".to_string());
            }
        } else {
            return Err("Cannot derive models endpoint from full URL".to_string());
        }
    } else if trimmed.ends_with("/v1beta") || trimmed.ends_with("/v1") {
        format!("{trimmed}/models")
    } else {
        format!("{trimmed}/v1beta/models")
    };

    let mut candidates = vec![native_endpoint];
    let openai_base_url = if !is_full_url {
        trimmed.strip_suffix("/v1beta").unwrap_or(base_url)
    } else {
        base_url
    };
    candidates.extend(build_models_url_candidates(
        openai_base_url,
        is_full_url,
        None,
    )?);
    Ok(deduplicate_urls(candidates))
}

fn deduplicate_urls(candidates: Vec<String>) -> Vec<String> {
    // 候选列表很短，线性去重比引入额外集合更直接。
    let mut unique = Vec::with_capacity(candidates.len());
    for url in candidates {
        if !unique.iter().any(|candidate| candidate == &url) {
            unique.push(url);
        }
    }
    unique
}

/// 截断响应体到 [`ERROR_BODY_MAX_CHARS`] 字符，避免 HTML 404 页占用错误串。
fn truncate_body(body: String) -> String {
    if body.chars().count() <= ERROR_BODY_MAX_CHARS {
        body
    } else {
        let mut s: String = body.chars().take(ERROR_BODY_MAX_CHARS).collect();
        s.push('…');
        s
    }
}

/// 若 baseURL 以任一已知兼容子路径结尾，返回剥离后的剩余部分；否则 `None`。
///
/// 依赖 [`KNOWN_COMPAT_SUFFIXES`] 按长度降序排列，确保最长前缀优先命中
/// （否则 `/anthropic` 会提前匹配掉 `/api/anthropic` 的场景）。
fn strip_compat_suffix(base_url: &str) -> Option<&str> {
    for suffix in KNOWN_COMPAT_SUFFIXES {
        if base_url.ends_with(*suffix) {
            return Some(&base_url[..base_url.len() - suffix.len()]);
        }
    }
    None
}

/// 判断 baseURL 是否以 OpenAI 风格的版本段 `/v{N}` 结尾（`N` 为一个或多个数字），
/// 例如 `/v1`、`.../paas/v4`。这类 URL 版本号已在路径中，模型端点应为
/// `{base}/models`，不能再补 `/v1`（智谱 Coding Plan 即 `.../coding/paas/v4`）。
fn ends_with_version_segment(url: &str) -> bool {
    let last = url.rsplit('/').next().unwrap_or("");
    last.strip_prefix('v')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_fetch_headers_follow_pi_api_format() {
        let anthropic =
            build_model_fetch_headers("anthropic-key", Some("anthropic-messages"), None, None)
                .unwrap();
        assert_eq!(anthropic["x-api-key"], "anthropic-key");
        assert!(!anthropic.contains_key(AUTHORIZATION));

        let google =
            build_model_fetch_headers("google-key", Some("google-generative-ai"), None, None)
                .unwrap();
        assert_eq!(google["x-goog-api-key"], "google-key");
        assert!(!google.contains_key(AUTHORIZATION));

        let openai =
            build_model_fetch_headers("openai-key", Some("openai-responses"), None, None).unwrap();
        assert_eq!(openai[AUTHORIZATION], "Bearer openai-key");
    }

    #[test]
    fn gemini_candidate_auth_uses_google_header_then_bearer_fallback() {
        let native_format = model_fetch_api_format_for_candidate(Some("google-generative-ai"), 0);
        let native_headers =
            build_model_fetch_headers("google-key", native_format, None, None).unwrap();
        assert_eq!(native_headers["x-goog-api-key"], "google-key");
        assert!(!native_headers.contains_key(AUTHORIZATION));

        let fallback_format = model_fetch_api_format_for_candidate(Some("google-generative-ai"), 1);
        let fallback_headers =
            build_model_fetch_headers("google-key", fallback_format, None, None).unwrap();
        assert_eq!(fallback_headers[AUTHORIZATION], "Bearer google-key");
        assert!(!fallback_headers.contains_key("x-goog-api-key"));
    }

    #[test]
    fn model_fetch_headers_allow_validated_header_only_auth_and_overrides() {
        let custom = BTreeMap::from([
            ("Authorization".to_string(), "Token literal".to_string()),
            ("X-Tenant".to_string(), "tenant-a".to_string()),
        ]);
        let headers =
            build_model_fetch_headers("", Some("openai-completions"), None, Some(&custom)).unwrap();
        assert_eq!(headers[AUTHORIZATION], "Token literal");
        assert_eq!(headers["x-tenant"], "tenant-a");

        let override_default =
            BTreeMap::from([("x-api-key".to_string(), "header-managed-key".to_string())]);
        let headers = build_model_fetch_headers(
            "provider-key",
            Some("anthropic-messages"),
            None,
            Some(&override_default),
        )
        .unwrap();
        assert_eq!(headers["x-api-key"], "header-managed-key");
    }

    #[test]
    fn model_fetch_headers_reject_invalid_or_missing_credentials() {
        assert!(build_model_fetch_headers("", None, None, None).is_err());
        let invalid = BTreeMap::from([("bad header".to_string(), "literal-value".to_string())]);
        assert!(build_model_fetch_headers("", None, None, Some(&invalid)).is_err());
    }

    #[test]
    fn model_fetch_error_body_redacts_known_header_credentials() {
        let secrets = vec![
            "short".to_string(),
            "Bearer literal-header-secret".to_string(),
        ];
        let body = redact_model_fetch_error_body(
            "invalid short / Bearer literal-header-secret".to_string(),
            &secrets,
        );
        assert_eq!(body, "invalid [REDACTED] / [REDACTED]");
    }

    #[test]
    fn test_candidates_plain_root() {
        let c = build_models_url_candidates("https://api.siliconflow.cn", false, None).unwrap();
        assert_eq!(c, vec!["https://api.siliconflow.cn/v1/models"]);
    }

    #[test]
    fn gemini_candidates_prefer_native_endpoint_then_openai_fallback() {
        let candidates = build_models_url_candidates_for_format(
            "https://api.tokenkey.dev",
            false,
            None,
            Some("google-generative-ai"),
        )
        .unwrap();
        assert_eq!(
            candidates,
            vec![
                "https://api.tokenkey.dev/v1beta/models",
                "https://api.tokenkey.dev/v1/models",
            ]
        );
    }

    #[test]
    fn gemini_candidates_do_not_duplicate_existing_version_segment() {
        let candidates = build_models_url_candidates_for_format(
            "https://relay.example.com/v1beta",
            false,
            None,
            Some("google-generative-ai"),
        )
        .unwrap();
        assert_eq!(
            candidates,
            vec![
                "https://relay.example.com/v1beta/models",
                "https://relay.example.com/v1/models",
            ]
        );
    }

    #[test]
    fn test_candidates_trailing_slash() {
        let c = build_models_url_candidates("https://api.example.com/", false, None).unwrap();
        assert_eq!(c, vec!["https://api.example.com/v1/models"]);
    }

    #[test]
    fn test_candidates_with_v1() {
        let c = build_models_url_candidates("https://api.example.com/v1", false, None).unwrap();
        assert_eq!(c, vec!["https://api.example.com/v1/models"]);
    }

    #[test]
    fn test_candidates_zhipu_coding_paas_v4() {
        // 智谱 Coding Plan 端点以 /v4 版本段结尾：模型端点是 {base}/models，
        // 正确路径必须排在 .../v4/v1/models（404）之前。
        let c =
            build_models_url_candidates("https://open.bigmodel.cn/api/coding/paas/v4", false, None)
                .unwrap();
        assert_eq!(
            c,
            vec![
                "https://open.bigmodel.cn/api/coding/paas/v4/models",
                "https://open.bigmodel.cn/api/coding/paas/v4/v1/models",
            ]
        );
    }

    #[test]
    fn test_candidates_zai_coding_paas_v4() {
        let c = build_models_url_candidates("https://api.z.ai/api/coding/paas/v4", false, None)
            .unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.z.ai/api/coding/paas/v4/models",
                "https://api.z.ai/api/coding/paas/v4/v1/models",
            ]
        );
    }

    #[test]
    fn test_ends_with_version_segment() {
        assert!(ends_with_version_segment("https://x.com/v1"));
        assert!(ends_with_version_segment(
            "https://open.bigmodel.cn/api/coding/paas/v4"
        ));
        assert!(ends_with_version_segment("https://x.com/v10"));
        assert!(!ends_with_version_segment("https://x.com/api"));
        assert!(!ends_with_version_segment("https://x.com/vX"));
        assert!(!ends_with_version_segment("https://x.com/models"));
        assert!(!ends_with_version_segment("https://api.siliconflow.cn"));
    }

    #[test]
    fn test_candidates_full_url() {
        let c = build_models_url_candidates(
            "https://proxy.example.com/v1/chat/completions",
            true,
            None,
        )
        .unwrap();
        assert_eq!(c, vec!["https://proxy.example.com/v1/models"]);
    }

    #[test]
    fn test_candidates_empty() {
        assert!(build_models_url_candidates("", false, None).is_err());
    }

    #[test]
    fn test_candidates_override_returns_single() {
        let c = build_models_url_candidates(
            "https://api.deepseek.com/anthropic",
            false,
            Some("https://api.deepseek.com/models"),
        )
        .unwrap();
        assert_eq!(c, vec!["https://api.deepseek.com/models"]);
    }

    #[test]
    fn test_candidates_override_empty_falls_through() {
        let c =
            build_models_url_candidates("https://api.siliconflow.cn", false, Some("   ")).unwrap();
        assert_eq!(c, vec!["https://api.siliconflow.cn/v1/models"]);
    }

    #[test]
    fn test_candidates_deepseek_strip_anthropic() {
        let c =
            build_models_url_candidates("https://api.deepseek.com/anthropic", false, None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.deepseek.com/anthropic/v1/models",
                "https://api.deepseek.com/v1/models",
                "https://api.deepseek.com/models",
            ]
        );
    }

    #[test]
    fn test_candidates_zhipu_strip_api_anthropic() {
        let c = build_models_url_candidates("https://open.bigmodel.cn/api/anthropic", false, None)
            .unwrap();
        assert_eq!(
            c,
            vec![
                "https://open.bigmodel.cn/api/anthropic/v1/models",
                "https://open.bigmodel.cn/v1/models",
                "https://open.bigmodel.cn/models",
            ]
        );
    }

    #[test]
    fn test_candidates_bailian_strip_apps_anthropic() {
        let c = build_models_url_candidates(
            "https://dashscope.aliyuncs.com/apps/anthropic",
            false,
            None,
        )
        .unwrap();
        assert_eq!(
            c,
            vec![
                "https://dashscope.aliyuncs.com/apps/anthropic/v1/models",
                "https://dashscope.aliyuncs.com/v1/models",
                "https://dashscope.aliyuncs.com/models",
            ]
        );
    }

    #[test]
    fn test_candidates_stepfun_strip_step_plan() {
        let c =
            build_models_url_candidates("https://api.stepfun.com/step_plan", false, None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.stepfun.com/step_plan/v1/models",
                "https://api.stepfun.com/v1/models",
                "https://api.stepfun.com/models",
            ]
        );
    }

    #[test]
    fn test_candidates_doubao_strip_api_coding() {
        let c = build_models_url_candidates(
            "https://ark.cn-beijing.volces.com/api/coding",
            false,
            None,
        )
        .unwrap();
        assert_eq!(
            c,
            vec![
                "https://ark.cn-beijing.volces.com/api/coding/v1/models",
                "https://ark.cn-beijing.volces.com/v1/models",
                "https://ark.cn-beijing.volces.com/models",
            ]
        );
    }

    #[test]
    fn test_candidates_rightcode_strip_claude() {
        let c = build_models_url_candidates("https://www.right.codes/claude", false, None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://www.right.codes/claude/v1/models",
                "https://www.right.codes/v1/models",
                "https://www.right.codes/models",
            ]
        );
    }

    #[test]
    fn test_candidates_longer_suffix_wins() {
        // baseURL 以 /api/anthropic 结尾时，应剥离整个 /api/anthropic，
        // 而不是只剥离 /anthropic（那样会得到残缺的 https://.../api 根）。
        let c = build_models_url_candidates("https://api.z.ai/api/anthropic", false, None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.z.ai/api/anthropic/v1/models",
                "https://api.z.ai/v1/models",
                "https://api.z.ai/models",
            ]
        );
    }

    #[test]
    fn test_candidates_no_suffix_no_strip() {
        let c = build_models_url_candidates("https://openrouter.ai/api", false, None).unwrap();
        assert_eq!(c, vec!["https://openrouter.ai/api/v1/models"]);
    }

    #[test]
    fn test_candidates_deduplicate() {
        // 虚构 case：baseURL 就是 "scheme://host"，剥不出子路径，应只有一个候选。
        let c = build_models_url_candidates("https://host.example.com", false, None).unwrap();
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn test_parse_response() {
        let json = r#"{"object":"list","data":[{"id":"gpt-4","object":"model","owned_by":"openai"},{"id":"claude-3-sonnet","object":"model","owned_by":"anthropic"}]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        let data = resp.data.unwrap();
        assert_eq!(data.len(), 2);
        assert_eq!(data[0].id, "gpt-4");
        assert_eq!(data[0].owned_by.as_deref(), Some("openai"));
        assert_eq!(data[1].id, "claude-3-sonnet");
    }

    #[test]
    fn test_parse_gemini_native_response() {
        let json =
            r#"{"models":[{"name":"models/gemini-2.5-pro"},{"name":"models/gemini-2.5-flash"}]}"#;
        let response: ModelsResponse = serde_json::from_str(json).unwrap();
        let models = normalize_models_response(response);
        assert_eq!(
            models.into_iter().map(|model| model.id).collect::<Vec<_>>(),
            vec!["gemini-2.5-flash", "gemini-2.5-pro"]
        );
    }

    #[test]
    fn test_non_array_models_does_not_reject_openai_data() {
        let json = r#"{"data":[{"id":"gpt-compatible"}],"models":{"unexpected":true}}"#;
        let response: ModelsResponse = serde_json::from_str(json).unwrap();
        let models = normalize_models_response(response);
        assert_eq!(
            models.into_iter().map(|model| model.id).collect::<Vec<_>>(),
            vec!["gpt-compatible"]
        );
    }

    #[test]
    fn test_parse_response_no_owned_by() {
        let json = r#"{"object":"list","data":[{"id":"my-model","object":"model"}]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        let data = resp.data.unwrap();
        assert_eq!(data[0].id, "my-model");
        assert!(data[0].owned_by.is_none());
    }

    #[test]
    fn test_parse_response_empty_data() {
        let json = r#"{"object":"list","data":[]}"#;
        let resp: ModelsResponse = serde_json::from_str(json).unwrap();
        assert!(resp.data.unwrap().is_empty());
    }
}
