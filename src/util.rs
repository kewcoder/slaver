use worker::*;

/// JSON response with permissive CORS headers (same-origin SPA, harmless to keep).
pub fn json(status: u16, value: &serde_json::Value) -> Result<Response> {
    let mut r = Response::from_json(value)?.with_status(status);
    cors(&mut r)?;
    Ok(r)
}

pub fn cors(r: &mut Response) -> Result<()> {
    let h = r.headers_mut();
    h.set("Access-Control-Allow-Origin", "*")?;
    h.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
    )?;
    h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")?;
    Ok(())
}

pub fn err(status: u16, msg: &str) -> Result<Response> {
    json(status, &serde_json::json!({ "error": msg }))
}

pub fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect()
    }
}
