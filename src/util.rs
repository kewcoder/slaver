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
