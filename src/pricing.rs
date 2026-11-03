//! Demo pricing table for the Meta Model API (USD per 1M tokens).
//!
//! Sources (Nov 2026): Muse Spark 1.3 contributor tier at
//! $0.10 input / $0.002 cached input / $0.20 output per 1M tokens;
//! Muse Wonder at $4.00 input / $0.20 cached input / $20.00 output.
//! Standard (non-contributor) tiers cost more — treat every figure here as
//! an estimate for demo credit math, not a billing quote.

pub struct Rates {
    pub input_per_m: f64,
    pub cached_per_m: f64,
    pub output_per_m: f64,
}

pub fn rates_for(model: &str) -> Rates {
    if model.contains("wonder") {
        Rates {
            input_per_m: 4.0,
            cached_per_m: 0.20,
            output_per_m: 20.0,
        }
    } else {
        // Default: Muse Spark contributor tier.
        Rates {
            input_per_m: 0.10,
            cached_per_m: 0.002,
            output_per_m: 0.20,
        }
    }
}

/// Cost of speech-to-text in USD for a clip of `seconds` length.
/// Muse Voice Transcribe is $3.00 per 1000 minutes of audio.
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
    fn spark_cost_math() {
        let r = rates_for("muse-spark-1.3");
        // 1M fresh input + 1M output at contributor rates = $0.30.
        let cost = cost_usd(&r, 1_000_000, 0, 1_000_000);
        assert!((cost - 0.30).abs() < 1e-9, "got {cost}");
    }

    #[test]
    fn cached_input_uses_cached_rate() {
        let r = rates_for("muse-spark-1.3");
        let cost = cost_usd(&r, 1_000_000, 1_000_000, 0);
        assert!((cost - 0.002).abs() < 1e-9, "got {cost}");
    }

    #[test]
    fn wonder_is_pricier() {
        let spark = cost_usd(&rates_for("muse-spark-1.3"), 10_000, 0, 5_000);
        let wonder = cost_usd(&rates_for("muse-wonder-1.0"), 10_000, 0, 5_000);
        assert!(wonder > spark * 10.0, "spark={spark} wonder={wonder}");
    }

    #[test]
    fn stt_cost_math() {
        // 60 s at $3/1000 min = $0.003.
        let cost = stt_cost_usd(60.0);
        assert!((cost - 0.003).abs() < 1e-12, "got {cost}");
        assert_eq!(stt_cost_usd(-5.0), 0.0);
    }

    #[test]
    fn unknown_model_falls_back_to_spark() {
        let r = rates_for("muse-something-new");
        assert!((r.input_per_m - 0.10).abs() < 1e-12);
    }
}
