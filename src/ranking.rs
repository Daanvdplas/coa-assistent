use crate::{Hit, Section};
pub fn cosine(left: &[f32], right: &[f32]) -> Result<f32, String> {
    if left.is_empty()
        || left.len() != right.len()
        || left.iter().chain(right).any(|v| !v.is_finite())
    {
        return Err("Incompatible or non-finite embedding vectors".into());
    }
    let dot: f32 = left.iter().zip(right).map(|(a, b)| a * b).sum();
    let norm = left.iter().map(|v| v * v).sum::<f32>().sqrt()
        * right.iter().map(|v| v * v).sum::<f32>().sqrt();
    if !norm.is_finite() || norm == 0.0 {
        return Err("Invalid embedding norm".into());
    }
    Ok((dot / norm).clamp(-1.0, 1.0))
}
pub fn rank(sections: &[Section], scores: &[f32], top_k: usize) -> Result<Vec<Hit>, String> {
    validate_top_k(top_k)?;
    if sections.len() != scores.len() || scores.iter().any(|score| !score.is_finite()) {
        return Err("Invalid section scores".into());
    }
    let mut hits: Vec<_> = sections
        .iter()
        .zip(scores)
        .map(|(section, similarity)| Hit {
            section: section.clone(),
            similarity: *similarity,
        })
        .collect();
    hits.sort_by(|a, b| {
        b.similarity
            .total_cmp(&a.similarity)
            .then(a.section.source_id.cmp(&b.section.source_id))
            .then(a.section.id.cmp(&b.section.id))
    });
    hits.truncate(top_k);
    Ok(hits)
}
pub fn validate_top_k(top_k: usize) -> Result<(), String> {
    if !(1..=6).contains(&top_k) {
        return Err(
            "top_k must be between 1 and 6 for this thirty-section activity experiment".into(),
        );
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cosine_compares_meaning_vectors_without_hiding_invalid_inputs() {
        for (left, right, expected) in [
            ([1., 0.], [1., 0.], 1.),
            ([1., 0.], [0., 1.], 0.),
            ([3., 4.], [1., 0.], 0.6),
            ([3., 4.], [10., 0.], 0.6),
            ([-3., -4.], [1., 0.], -0.6),
        ] {
            let actual = cosine(&left, &right).unwrap();
            assert!(
                (actual - expected).abs() < 1e-6,
                "cosine({left:?}, {right:?}): expected {expected}, got {actual}"
            );
        }
        assert!(cosine(&[0., 0.], &[1., 0.]).is_err());
        assert!(cosine(&[1.], &[1., 0.]).is_err());
        assert!(cosine(&[f32::NAN], &[1.]).is_err());
    }
    #[test]
    fn top_k_is_bounded_and_ties_use_source_ids() {
        let sections: Vec<_> = [("C", "S1"), ("B", "S3"), ("B", "S1"), ("A", "S1")]
            .iter()
            .map(|(source_id, id)| Section {
                source_id: (*source_id).into(),
                source_date: "2026-10-20".into(),
                source_title: "Example".into(),
                id: (*id).into(),
                heading: "Heading".into(),
                text: "Exact evidence".into(),
            })
            .collect();
        let hits = rank(&sections, &[0.8, 0.8, 0.8, 0.3], 3).unwrap();
        assert_eq!(
            hits.iter()
                .map(|hit| (hit.section.source_id.as_str(), hit.section.id.as_str()))
                .collect::<Vec<_>>(),
            [("B", "S1"), ("B", "S3"), ("C", "S1")]
        );
        assert!(hits.iter().all(|hit| hit.similarity == 0.8));
        assert!(validate_top_k(0).is_err());
        assert!(validate_top_k(7).is_err());
        assert!(rank(&sections, &[0.3], 2).is_err());
    }
}
