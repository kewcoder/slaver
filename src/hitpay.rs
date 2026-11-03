//! HitPay integration (sandbox by default, production by env switch).
//!
//! Flow: licenses_checkout creates a HitPay payment request and returns the
//! hosted checkout URL. The user pays at HitPay; HitPay POSTs to
//! /hooks/hitpay and redirects the browser back to the app. Activation
//! ALWAYS re-checks status server-side (`GET payment-requests/{id}`) so a
//! forged redirect/webhook can never mint a license.

use serde_json::Value;

fn base_url() -> String {
    std::env::var("HITPAY_BASE_URL")
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/')
        .to_string()
        .let_if_empty("https://api.sandbox.hit-pay.com".to_string())
}

fn api_key() -> String {
    std::env::var("HITPAY_API_KEY").unwrap_or_default().trim().to_string()
}

pub fn configured() -> bool {
    !api_key().is_empty()
}

pub fn is_sandbox() -> bool {
    base_url().contains("sandbox")
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("http client builds")
}

trait OrDefault {
    fn let_if_empty(self, d: String) -> String;
}
impl OrDefault for String {
    fn let_if_empty(self, d: String) -> String {
        if self.is_empty() {
            d
        } else {
            self
        }
    }
}

/// Create a payment request. Returns (hitpay_request_id, checkout_url).
pub async fn create_payment_request(
    amount_major: f64,
    currency: &str,
    name: &str,
    email: &str,
    reference_number: &str,
    purpose: &str,
    redirect_url: &str,
    webhook_url: &str,
) -> anyhow::Result<(String, String)> {
    let key = api_key();
    if key.is_empty() {
        anyhow::bail!("HITPAY_API_KEY is not set.");
    }
    let payload = serde_json::json!({
        "amount": amount_major,
        "currency": currency,
        "name": name,
        "email": email,
        "reference_number": reference_number,
        "purpose": purpose,
        "redirect_url": redirect_url,
        "webhook": webhook_url,
        "expires_after": "60 mins",
        "metadata": { "source": "slaver" },
    });
    let resp = client()
        .post(format!("{}/v1/payment-requests", base_url()))
        .header("X-BUSINESS-API-KEY", key)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await?;
    let status = resp.status().as_u16();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let msg = v
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("HitPay request failed.");
        anyhow::bail!("HitPay error ({status}): {msg}");
    }
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if id.is_empty() || url.is_empty() {
        anyhow::bail!("HitPay returned an unusable payment request.");
    }
    Ok((id, url))
}

/// Server-side status check. Returns (status, paid_bool).
/// Accepts the shapes HitPay uses across payment-request payloads.
pub async fn payment_status(hitpay_request_id: &str) -> anyhow::Result<(String, bool)> {
    let key = api_key();
    if key.is_empty() {
        anyhow::bail!("HITPAY_API_KEY is not set.");
    }
    let resp = client()
        .get(format!("{}/v1/payment-requests/{hitpay_request_id}", base_url()))
        .header("X-BUSINESS-API-KEY", key)
        .send()
        .await?;
    let status = resp.status().as_u16();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        anyhow::bail!("HitPay status check failed ({status}).");
    }
    // Try several shapes: {status}, {data:{status}}, nested payments[0].status.
    let direct = v.get("status").and_then(|x| x.as_str()).unwrap_or("").to_lowercase();
    let nested = v
        .get("data")
        .and_then(|d| d.get("status"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_lowercase();
    let pay0 = v
        .get("payments")
        .and_then(|p| p.as_array())
        .and_then(|a| a.first())
        .and_then(|p| p.get("status"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_lowercase();
    let st = if !direct.is_empty() {
        direct
    } else if !nested.is_empty() {
        nested
    } else {
        pay0
    };
    let paid = matches!(st.as_str(), "completed" | "succeeded" | "paid" | "success");
    Ok((if st.is_empty() { "unknown".to_string() } else { st }, paid))
}

/// Best-effort HMAC check for event webhooks (Hitpay-Signature over raw body
/// with the per-endpoint salt). Returns true when configured salt matches;
/// callers MUST still confirm via [`payment_status`].
pub fn verify_event_signature(raw_body: &[u8], signature: &str, salt: &str) -> bool {
    if salt.is_empty() || signature.is_empty() {
        return false;
    }
    use hmac::Mac;
    let mut mac = match hmac::Hmac::<sha2::Sha256>::new_from_slice(salt.as_bytes()) {
        Ok(m) => m,
        Err(_) => return false,
    };
    mac.update(raw_body);
    let hex = hex::encode(mac.finalize().into_bytes());
    subtle_eq(&hex, &signature.to_lowercase())
}

fn subtle_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn webhook_salt() -> String {
    std::env::var("HITPAY_WEBHOOK_SALT").unwrap_or_default()
}

pub fn app_base_url() -> String {
    std::env::var("APP_BASE_URL")
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/')
        .to_string()
        .let_if_empty("https://www.slaver.app".to_string())
}
