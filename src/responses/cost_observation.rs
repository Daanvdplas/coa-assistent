//! Read-only estimates for the private trace. Serving never consults these numbers.
use super::MODEL;
use serde_json::{Value, json};

pub(crate) const PRICE_TABLE: &str = "gpt-6.1-sol-standard-2026-11-26";

pub(super) fn observe(response: &Value, offline: bool) -> Value {
    let usage = &response["usage"];
    let details = &usage["input_tokens_details"];
    let writes = &details["cache_write_tokens_details"];
    let input = usage["input_tokens"].as_u64();
    let output = usage["output_tokens"].as_u64();
    let read = details["cached_tokens"].as_u64();
    let write = details["cache_write_tokens"].as_u64();
    let write_30m = writes["ttl_30m_tokens"].as_u64();
    let write_12h = writes["ttl_12h_tokens"].as_u64();
    let tier = response["service_tier"].as_str().filter(|tier| {
        matches!(
            *tier,
            "default" | "auto" | "flex" | "priority" | "fast" | "ultrafast" | "scale"
        )
    });
    let cache_fields_missing = [read, write, write_30m, write_12h]
        .iter()
        .any(Option::is_none);
    let estimate = if offline {
        Err("offline_mock")
    } else if response["model"].as_str() != Some(MODEL) {
        Err("unknown_model")
    } else if tier != Some("default") {
        Err("unknown_or_nonstandard_tier")
    } else {
        match (input, output, read, write, write_30m, write_12h) {
            (None, _, _, _, _, _) | (_, None, _, _, _, _) => Err("missing_token_counts"),
            (
                Some(input),
                Some(output),
                Some(read),
                Some(write),
                Some(write_30m),
                Some(write_12h),
            ) => {
                if input == 0
                    || write_30m.checked_add(write_12h) != Some(write)
                    || usage["output_tokens_details"]["reasoning_tokens"]
                        .as_u64()
                        .is_some_and(|reasoning| reasoning > output)
                    || usage["total_tokens"]
                        .as_u64()
                        .is_some_and(|total| input.checked_add(output) != Some(total))
                {
                    Err("inconsistent_token_counts")
                } else {
                    estimate_nanodollars(input, output, read, write, write_30m, write_12h)
                        .ok_or("inconsistent_token_counts")
                }
            }
            _ => Err("missing_cache_fields"),
        }
    };
    json!({
        "pricing_status": estimate.as_ref().map_or_else(|error| *error, |_| "priced"),
        "price_table": PRICE_TABLE,
        "estimated_usd_nanodollars": estimate.ok(),
        "service_tier": tier,
        "input_tokens": input,
        "output_tokens": output,
        "cached_input_tokens": read,
        "cache_write_tokens": write,
        "cache_write_30m_tokens": write_30m,
        "cache_write_12h_tokens": write_12h,
        "cache_fields_missing": cache_fields_missing,
    })
}

fn estimate_nanodollars(
    input: u64,
    output: u64,
    read: u64,
    write: u64,
    write_30m: u64,
    write_12h: u64,
) -> Option<u64> {
    let ordinary = input.checked_sub(read)?.checked_sub(write)?;
    // Rates are USD nanodollars per token. Long context reprices the full request.
    let (input_multiplier, output_rate) = if input > 272_000 {
        (2, 15_000)
    } else {
        (1, 10_000)
    };
    let subtotal = u128::from(ordinary) * 2_000
        + u128::from(read) * 100
        + u128::from(write_30m) * 2_500
        + u128::from(write_12h) * 5_000;
    u64::try_from(subtotal * input_multiplier + u128::from(output) * output_rate).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(input: u64) -> Value {
        json!({
            "model":MODEL, "service_tier":"default",
            "usage":{
                "input_tokens":input, "output_tokens":25,
                "input_tokens_details":{
                    "cached_tokens":20, "cache_write_tokens":15,
                    "cache_write_tokens_details":{"ttl_30m_tokens":10,"ttl_12h_tokens":5}
                }
            }
        })
    }

    #[test]
    fn applies_disjoint_cache_rates_and_reprices_the_entire_long_request() {
        for (input, expected) in [
            (100, 432_000),
            (272_000, 544_232_000),
            (272_001, 1_088_343_000),
        ] {
            let observation = observe(&response(input), false);
            assert_eq!(observation["estimated_usd_nanodollars"], expected);
            assert_eq!(observation["pricing_status"], "priced");
        }
    }

    #[test]
    fn leaves_missing_incompatible_and_contradictory_usage_unpriced() {
        let mut missing = response(100);
        missing["usage"]["input_tokens_details"]["cache_write_tokens_details"] = Value::Null;
        let mut conflicting = response(100);
        conflicting["usage"]["input_tokens_details"]["cache_write_tokens"] = json!(16);
        let mut alternate = response(100);
        alternate["service_tier"] = json!("flex");
        let mut unknown = response(100);
        unknown["service_tier"] = json!("PRIVATE-TIER-CANARY");
        for (raw, expected) in [
            (missing, "missing_cache_fields"),
            (conflicting, "inconsistent_token_counts"),
            (response(30), "inconsistent_token_counts"),
            (alternate, "unknown_or_nonstandard_tier"),
            (unknown, "unknown_or_nonstandard_tier"),
        ] {
            let observation = observe(&raw, false);
            assert_eq!(observation["pricing_status"], expected);
            assert_eq!(observation["estimated_usd_nanodollars"], Value::Null);
            assert!(!observation.to_string().contains("PRIVATE-TIER-CANARY"));
        }
    }
}
