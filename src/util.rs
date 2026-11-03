use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde_json::Value;

/// JSON response.
pub fn json(status: u16, value: &Value) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    (code, Json(value.clone())).into_response()
}

pub fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect()
    }
}

/// Random v4-style id (`xxxxxxxx-xxxx-...`), hex-encoded.
pub fn new_id() -> String {
    let mut b = [0u8; 16];
    if getrandom::getrandom(&mut b).is_err() {
        let t = crate::db::now_millis();
        b[..8].copy_from_slice(&t.to_be_bytes());
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}
