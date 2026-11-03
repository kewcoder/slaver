//! Demo pricing table for OpenRouter models (USD per 1M tokens).
//!
//! Sources: the live OpenRouter catalog (GET /api/v1/models), Nov 2026.
//! Cached-input rates are estimates (roughly 10% of input) — treat every
//! figure here as demo credit math, not a billing quote.

pub struct Rates {
    pub input_per_m: f64,
    pub cached_per_m: f64,
    pub output_per_m: f64,
}

fn r(input: f64, cached: f64, output: f64) -> Rates {
    Rates { input_per_m: input, cached_per_m: cached, output_per_m: output }
}

pub fn rates_for(model: &str) -> Rates {
    // Strip the " (summary)" suffix cron summaries attach.
    let model = model.strip_suffix(" (summary)").unwrap_or(model);
    match model {
        "muse-spark-1.3" => r(0.10, 0.002, 0.20),
        "muse-wonder-1.0" => r(4.0, 0.20, 20.0),
        "qwen/qwen3.7-flash" => r(0.03, 0.005, 0.13),
        "meta-llama/llama-3.3-70b-instruct" => r(0.10, 0.01, 0.32),
        "anthropic/claude-haiku-5.5" => r(0.10, 0.01, 0.50),
        "deepseek/deepseek-chat" => r(0.26, 0.03, 1.03),
        "openai/gpt-5-mini" => r(0.25, 0.025, 2.00),
        "google/gemini-2.5-flash" => r(0.30, 0.03, 2.50),
        "mistralai/mistral-medium-3-5" => r(1.50, 0.15, 7.50),
        "x-ai/grok-4.5" => r(2.00, 0.20, 6.00),
        "anthropic/claude-sonnet-5" => r(2.00, 0.20, 10.00),
        // Unknown model: bill like the default instead of free.
        _ => r(0.10, 0.01, 0.32),
    }
}

/// Cost of speech-to-text in USD for a clip of `seconds` length.
/// Meta's Muse Voice Transcribe is $3.00 per 1000 minutes of audio
/// (OpenRouter exposes no transcription endpoint, so STT stays on Meta).
pub fn tts_cost_usd(chars: usize) -> f64 {
    chars as f64 / 1000.0 * 0.015
}

pub fn stt_cost_usd(seconds: f64) -> f64 {
    seconds.max(0.0) * 3.0 / 60_000.0
}

/// Rough token estimate from text length (OpenAI's ~4 chars/token rule).
/// Used only when the provider does not report exact usage.
pub fn estimate_tokens(text: &str) -> u64 {
    ((text.len() as f64) / 4.0).ceil() as u64
}

pub fn cost_usd(rates: &Rates, prompt: u64, cached: u64, completion: u64) -> f64 {
    let fresh = prompt.saturating_sub(cached);
    (fresh as f64) * rates.input_per_m / 1_000_000.0
        + (cached as f64) * rates.cached_per_m / 1_000_000.0
        + (completion as f64) * rates.output_per_m / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_model_cost_math() {
        let r = rates_for("meta-llama/llama-3.3-70b-instruct");
        // 1M fresh input + 1M output at $0.10/$0.32 = $0.42.
        let cost = cost_usd(&r, 1_000_000, 0, 1_000_000);
        assert!((cost - 0.42).abs() < 1e-9, "got {cost}");
    }

    #[test]
    fn cached_input_uses_cached_rate() {
        let r = rates_for("meta-llama/llama-3.3-70b-instruct");
        let cost = cost_usd(&r, 1_000_000, 1_000_000, 0);
        assert!((cost - 0.01).abs() < 1e-9, "got {cost}");
    }

    #[test]
    fn sonnet_is_pricier_than_default() {
        let cheap = cost_usd(&rates_for("meta-llama/llama-3.3-70b-instruct"), 10_000, 0, 5_000);
        let pricey = cost_usd(&rates_for("anthropic/claude-sonnet-5"), 10_000, 0, 5_000);
        assert!(pricey > cheap * 10.0, "cheap={cheap} pricey={pricey}");
    }

    #[test]
    fn stt_cost_math() {
        // 60 s at $3/1000 min = $0.003.
        let cost = stt_cost_usd(60.0);
        assert!((cost - 0.003).abs() < 1e-12, "got {cost}");
        assert_eq!(stt_cost_usd(-5.0), 0.0);
    }

    #[test]
    fn unknown_model_falls_back_to_default() {
        let r = rates_for("some-future-model");
        assert!((r.input_per_m - 0.10).abs() < 1e-12);
    }
}
