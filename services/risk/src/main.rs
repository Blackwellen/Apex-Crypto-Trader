//! `apex-risk` CLI: evaluate a risk input against a policy stack, both read as JSON from stdin.
//! stdin: {"global": {...}, "layers": [["Bucket", {...}], ...], "input": {...}}   stdout: decision JSON.
//! Pure function of its input; performs no I/O besides stdin/stdout.
use apex_risk::{evaluate, Level, Policy, PolicyLayer, RiskInput};
use std::io::Read;

fn main() -> anyhow::Result<()> {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s)?;
    let v: serde_json::Value = serde_json::from_str(&s)?;
    let root = Policy::global_from_json(v.get("global").unwrap_or(&serde_json::json!({})))?;
    let mut layers: Vec<(Level, PolicyLayer)> = Vec::new();
    if let Some(arr) = v.get("layers").and_then(|x| x.as_array()) {
        for e in arr {
            let lv: Level = serde_json::from_value(e[0].clone())?;
            layers.push((lv, PolicyLayer::from_json(&e[1])?));
        }
    }
    let input: RiskInput = serde_json::from_value(v["input"].clone())?;
    let policy = Policy::resolve(&root, &layers);
    let d = evaluate(&policy, &input);
    println!("{}", serde_json::json!({ "decision": d.as_db_str(), "reasons": d.reasons_json() }));
    Ok(())
}
