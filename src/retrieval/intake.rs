//! Literal criteria and evidence delivery for the opt-in intake experiment.
use super::{
    ActivityRecord, ContextOmission, Environment, Inclusion, PreparedCorpus, RetrievalHit,
    RetrievalOutcome, SectionKey, Weekday, estimate_section_tokens,
};
use crate::Section;
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Debug, Default, Clone, Serialize)]
pub(crate) struct IntakeDecision {
    pub applied: bool,
    pub exhaustive: bool,
    pub matches: Vec<String>,
    pub unknown: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Time {
    StartsAt(u16),
    ActiveAt(u16),
    Before(u16),
    Afternoon,
    Morning,
}

#[derive(Default)]
struct Fields {
    description: bool,
    schedule: bool,
    place: bool,
    supplies: bool,
    guidance: bool,
}

struct Intake {
    all: bool,
    days: Vec<Weekday>,
    environment: Option<Environment>,
    time: Option<Time>,
    free: bool,
    supplied: bool,
    address: Option<(String, u16)>,
    fields: Fields,
    names: BTreeSet<String>,
    restrict_names: bool,
}

const DAYS: [(Weekday, [&str; 2]); 7] = [
    (Weekday::Monday, ["maandag", "monday"]),
    (Weekday::Tuesday, ["dinsdag", "tuesday"]),
    (Weekday::Wednesday, ["woensdag", "wednesday"]),
    (Weekday::Thursday, ["donderdag", "thursday"]),
    (Weekday::Friday, ["vrijdag", "friday"]),
    (Weekday::Saturday, ["zaterdag", "saturday"]),
    (Weekday::Sunday, ["zondag", "sunday"]),
];

fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| !(c.is_alphanumeric() || matches!(c, ':' | '.')))
        .map(|word| word.trim_matches(['.', ':']))
        .filter(|word| !word.is_empty())
}

fn has(words: &[&str], values: &[&str]) -> bool {
    values.iter().any(|word| words.contains(word))
}

fn phrases(text: &str, values: &[&str]) -> bool {
    values.iter().any(|value| text.contains(value))
}

fn take_title<'a>(corpus: &'a PreparedCorpus, tokens: &[&str]) -> Option<(&'a str, usize)> {
    corpus
        .activities
        .iter()
        .filter_map(|activity| {
            let normalized = activity.title.to_lowercase();
            let title: Vec<_> = words(&normalized).collect();
            let consumed = if tokens.starts_with(&title) {
                title.len()
            } else if matches!(tokens, ["de" | "het" | "the", rest @ ..] if rest.starts_with(&title)) {
                title.len() + 1
            } else {
                return None;
            };
            Some((activity.id.as_str(), consumed))
        })
        .max_by_key(|(_, consumed)| *consumed)
}

fn named_subset(corpus: &PreparedCorpus, text: &str) -> Option<Option<BTreeSet<String>>> {
    for clause in text
        .split(['?', '!', ';'])
        .flat_map(|clause| clause.split(". "))
    {
        let tokens: Vec<_> = clause
            .split_inclusive(',')
            .flat_map(|part| words(part).chain(part.ends_with(',').then_some(",")))
            .collect();
        let (mut remaining, fronted_dutch) = match tokens.as_slice() {
            ["which", "of", "these" | "those", ..]
            | ["welke", "van", "deze" | "die", ..]
            | [
                "which",
                "of",
                "the",
                "following" | "activities" | "options",
                ..,
            ]
            | [
                "welke",
                "van",
                "de",
                "volgende" | "activiteiten" | "opties",
                ..,
            ] => continue,
            ["which", "of", names @ ..] | ["welke", "van", names @ ..] => (names, false),
            ["van", names @ ..] if take_title(corpus, names).is_some() => (names, true),
            _ => continue,
        };

        let mut names = BTreeSet::new();
        loop {
            let (title, consumed) = take_title(corpus, remaining)?;
            names.insert(title.to_owned());
            remaining = &remaining[consumed..];
            let (next, separated) = match remaining {
                [",", "and" | "en" | "or" | "of", tail @ ..] => (tail, true),
                [",", tail @ ..] if take_title(corpus, tail).is_some() => (tail, true),
                ["and" | "en" | "or" | "of", tail @ ..] => (tail, true),
                _ => (remaining, false),
            };
            remaining = next;
            if !separated {
                break;
            }
        }
        let question = remaining.strip_prefix(&[","]).unwrap_or(remaining);
        if names.len() < 2
            || matches!(
                question,
                ["plus" | "including" | "inclusief", ..] | ["as", "well", "as", ..]
            )
            || (fronted_dutch
                && !matches!(
                    question,
                    ["welke", ..] | ["wil", "ik", "weten", "welke", ..]
                ))
        {
            return None;
        }
        return Some(Some(names));
    }
    Some(None)
}

fn parse_clock(word: &str) -> Option<u16> {
    let (hour, minute) = word.split_once(['.', ':'])?;
    if !(1..=2).contains(&hour.len()) || minute.len() != 2 {
        return None;
    }
    let hour: u16 = hour.parse().ok()?;
    let minute: u16 = minute.parse().ok()?;
    (hour < 24 && minute < 60).then_some(hour * 60 + minute)
}

fn addresses(words: &[&str]) -> impl Iterator<Item = (String, u16)> {
    words.windows(2).filter_map(|pair| {
        let street = pair[0];
        let street_endings = [
            "straat", "laan", "pad", "weg", "plein", "dreef", "kade", "singel",
        ];
        if street_endings.iter().any(|ending| street.ends_with(ending)) {
            Some((street.into(), pair[1].parse().ok()?))
        } else {
            None
        }
    })
}

fn clock_modifier(word: &str) -> bool {
    [
        "om", "at", "precies", "exact", "exactly", "sharp", "uur", "op", "on", "a", "de", "the",
        "binnen", "buiten", "indoors", "outdoors", "al", "nog", "already", "still",
    ]
    .contains(&word)
        || DAYS.iter().any(|(_, names)| names.contains(&word))
}

fn fronted_activity_subject(word: &str) -> bool {
    matches!(
        word,
        "welke"
            | "which"
            | "what"
            | "activiteit"
            | "activiteiten"
            | "activity"
            | "activities"
            | "binnenactiviteit"
            | "binnenactiviteiten"
            | "buitenactiviteit"
            | "buitenactiviteiten"
            | "indoor"
            | "outdoor"
            | "are"
            | "is"
            | "zijn"
            | "gaan"
            | "gaat"
            | "er"
            | "dan"
    )
}

fn time_predicate(words: &[&str], index: usize, minutes: u16) -> Option<Time> {
    let previous = index.checked_sub(1).map_or("", |i| words[i]);
    let next = words.get(index + 1).copied().unwrap_or_default();
    match (previous, words[index], next) {
        (_, "beginnen" | "begint" | "start" | "starten" | "starts" | "starting" | "begin", _)
        | (_, "van", "start") => Some(Time::StartsAt(minutes)),
        (_, "bezig" | "running" | "ongoing" | "active" | "run" | "underway", _)
        | ("under", "way", _)
        | (_, "under", "way")
        | ("in", "progress", _)
        | (_, "in", "progress")
        | ("taking", "place", _)
        | (_, "taking", "place") => Some(Time::ActiveAt(minutes)),
        (_, "voor" | "before", _) => Some(Time::Before(minutes)),
        _ => None,
    }
}

fn negation_at(words: &[&str], index: usize) -> bool {
    matches!(words[index], "niet" | "not" | "cannot")
        || (words[index] == "t"
            && index
                .checked_sub(1)
                .is_some_and(|previous| words[previous].ends_with('n')))
}

fn stopped_predicate(words: &[&str]) -> bool {
    words
        .windows(2)
        .any(|pair| matches!(pair, ["no", "longer"] | ["niet", "meer"]))
}

fn denies_availability(clause: &str) -> bool {
    let words: Vec<_> = self::words(clause).collect();
    words.windows(2).enumerate().any(|(index, pair)| {
        if !matches!(
            pair,
            ["ik", "ben" | "kan"] | ["i", "am" | "m" | "can" | "cannot"]
        ) {
            return false;
        }
        let mut denied = pair[1] == "cannot";
        let mut availability = false;
        for index in index + 2..words.len() {
            let word = words[index];
            if negation_at(&words, index) {
                denied = true;
            } else if matches!(
                word,
                "vrij"
                    | "beschikbaar"
                    | "free"
                    | "available"
                    | "meedoen"
                    | "komen"
                    | "join"
                    | "attend"
                    | "ochtend"
                    | "middag"
                    | "morning"
                    | "afternoon"
            ) || parse_clock(word).is_some()
                || DAYS.iter().any(|(_, names)| names.contains(&word))
            {
                availability = true;
            } else if !clock_modifier(word)
                && !matches!(word, "but" | "maar" | "in" | "only" | "alleen" | "wel")
            {
                break;
            }
        }
        denied && availability
    })
}

fn resident_clock(words: &[&str], before: usize, after: Option<usize>) -> bool {
    let left = &words[..=before];
    let ends_with = |patterns: &[&[&str]]| patterns.iter().any(|pattern| left.ends_with(pattern));
    let availability_after = after.is_some_and(|index| {
        [
            "vrij",
            "beschikbaar",
            "free",
            "available",
            "komen",
            "meedoen",
            "join",
            "attend",
        ]
        .contains(&words[index])
    });
    (availability_after
        && ends_with(&[
            &["ik", "ben"],
            &["ik", "kan"],
            &["i", "am"],
            &["i", "m"],
            &["i", "can"],
        ]))
        || ends_with(&[
            &["ik", "ben", "vrij"],
            &["ik", "ben", "beschikbaar"],
            &["i", "am", "free"],
            &["i", "m", "free"],
            &["i", "am", "available"],
            &["i", "m", "available"],
            &["i", "can", "join"],
            &["i", "can", "attend"],
            &["ik", "kan", "meedoen"],
            &["ik", "kan", "komen"],
        ])
}

fn clock_filter(words: &[&str], index: usize, minutes: u16) -> Option<Time> {
    // Cross only literal time/weekday modifiers, so nearby requested fields do not supply a filter.
    let before = words[..index]
        .iter()
        .rposition(|word| !clock_modifier(word));
    let after = words[index + 1..]
        .iter()
        .position(|word| {
            !clock_modifier(word) && !(before.is_none() && fronted_activity_subject(word))
        })
        .map(|offset| index + 1 + offset);

    if before.is_some_and(|i| {
        (i.saturating_sub(2)..=i).any(|j| negation_at(words, j))
            || stopped_predicate(&words[i.saturating_sub(3)..=i])
    }) || after.is_some_and(|i| {
        negation_at(words, i)
            || stopped_predicate(&words[i..words.len().min(i + 2)])
            || ["of", "or", "later", "eerder", "earlier", "onwards"].contains(&words[i])
    }) {
        return None;
    }

    let left = before.and_then(|i| time_predicate(words, i, minutes));
    let right = after.and_then(|i| {
        // In “running at 14:00, start time and day”, start time is a requested field.
        if matches!(words.get(i + 1), Some(&("time" | "times"))) {
            return None;
        }
        time_predicate(words, i, minutes).filter(|time| !matches!(time, Time::Before(_)))
    });
    match (left, right) {
        (Some(left), Some(right)) if left != right => None,
        (left, right) => left.or(right).or_else(|| {
            before
                .is_some_and(|index| resident_clock(words, index, after))
                .then_some(Time::ActiveAt(minutes))
        }),
    }
}

fn read_time(text: &str, words: &[&str]) -> Option<Option<Time>> {
    if words.windows(2).any(|pair| {
        (pair[0].parse::<u16>().is_ok() || parse_clock(pair[0]).is_some())
            && ["am", "pm", "a.m", "p.m"].contains(&pair[1])
    }) {
        return None;
    }
    let clocks: Vec<_> = words
        .iter()
        .filter(|word| {
            word.split_once(['.', ':'])
                .is_some_and(|(hour, _)| hour.bytes().all(|byte| byte.is_ascii_digit()))
        })
        .map(|word| parse_clock(word))
        .collect::<Option<_>>()?;
    if clocks.len() > 1 {
        return None;
    }
    if let Some(&minutes) = clocks.first() {
        for clause in text
            .split(['?', '!', ';'])
            .flat_map(|clause| clause.split(". "))
        {
            let clause_words: Vec<_> = self::words(clause).collect();
            if let Some(index) = clause_words
                .iter()
                .position(|word| parse_clock(word) == Some(minutes))
            {
                return clock_filter(&clause_words, index, minutes).map(Some);
            }
        }
        return None;
    }
    if has(words, &["middag", "afternoon"]) || words.iter().any(|word| word.ends_with("middag")) {
        return Some(Some(Time::Afternoon));
    }
    if has(words, &["ochtend", "morning"]) || words.iter().any(|word| word.ends_with("ochtend")) {
        return Some(Some(Time::Morning));
    }
    Some(None)
}

fn read_intake(corpus: &PreparedCorpus, question: &str) -> Option<Intake> {
    let text = question.to_lowercase();
    let words: Vec<_> = words(&text).collect();
    if text
        .split(['?', '!'])
        .flat_map(|clause| clause.split(". "))
        .any(denies_availability)
        || phrases(
            &text,
            &[
                "niet binnen",
                "niet buiten",
                "not indoors",
                "not outdoors",
                "not free",
                "except on",
                "behalve op",
                "bij voorkeur",
                "would rather",
                "liefst",
            ],
        )
        || has(
            &words,
            &[
                "allergenen",
                "allergie",
                "allergy",
                "sesam",
                "rolstoel",
                "wheelchair",
                "beschikbaarheid",
                "availability",
                "wachtwoorden",
                "passwords",
                "prefer",
                "preferably",
                "voorkeur",
            ],
        )
        || phrases(&text, &["nog plek", "vrije plekken", "spots available"])
    {
        return None;
    }
    let indoor = has(
        &words,
        &[
            "binnen",
            "binnenactiviteit",
            "binnenactiviteiten",
            "indoor",
            "indoors",
        ],
    );
    let outdoor = has(
        &words,
        &[
            "buiten",
            "buitenactiviteit",
            "buitenactiviteiten",
            "outdoor",
            "outdoors",
            "outside",
        ],
    );
    let environment = match (indoor, outdoor) {
        (true, false) => Some(Environment::Indoor),
        (false, true) => Some(Environment::Outdoor),
        (false, false) => None,
        (true, true) => return None,
    };
    let days: Vec<_> = DAYS
        .into_iter()
        .filter(|(_, names)| {
            has(&words, names)
                || words.iter().any(|word| {
                    names.iter().any(|day| {
                        word.strip_prefix(day)
                            .is_some_and(|end| matches!(end, "ochtend" | "middag"))
                    })
                })
        })
        .map(|(day, _)| day)
        .collect();
    if days.len() > 1 && !has(&words, &["of", "or"]) {
        return None;
    }
    let time = read_time(&text, &words)?;
    let one = phrases(
        &text,
        &[
            "noem één",
            "geef één",
            "kies één",
            "één activiteit",
            "één optie",
            "one activity",
            "one option",
            "give one",
            "tell me one",
            "name one",
            "suggest one",
        ],
    );
    let explicit_all = has(&words, &["alle", "allemaal", "all", "each"]);
    if one && explicit_all {
        return None;
    }
    let comparison_request =
        has(&words, &["compare", "vergelijk"]) || phrases(&text, &["naast elkaar", "side by side"]);
    let subset = named_subset(corpus, &text)?;
    let explicit_subset = subset.is_some();
    let all = explicit_all
        || (!one
            && phrases(
                &text,
                &[
                    "elke passende",
                    "per activiteit",
                    "welke activiteiten",
                    "which activities",
                    "welke van deze",
                    "welke binnenactiviteiten",
                    "welke buitenactiviteiten",
                    "which indoor activities",
                    "which outdoor activities",
                ],
            ));
    let broad = all
        || one
        || comparison_request
        || explicit_subset
        || phrases(
            &text,
            &[
                "welke activiteit",
                "which activity",
                "iets doen",
                "something to do",
                "ik zoek",
                "i am looking",
                "i'm looking",
                "een activiteit",
                "an activity",
            ],
        );
    if !broad {
        return None;
    }

    let legacy_subset = phrases(
        &text,
        &[
            "welke van deze",
            "which of these",
            "welke van de",
            "which of the",
        ],
    );
    let padded = format!(" {} ", words.join(" "));
    let names: BTreeSet<_> = subset.unwrap_or_else(|| {
        corpus
            .activities
            .iter()
            .filter(|activity| {
                let title = activity.title.to_lowercase();
                padded.contains(&format!(
                    " {} ",
                    self::words(&title).collect::<Vec<_>>().join(" ")
                ))
            })
            .map(|activity| activity.id.clone())
            .collect()
    });
    let comparison = (comparison_request || explicit_subset || legacy_subset) && names.len() >= 2;
    let all = all || comparison;
    let restrict_names = legacy_subset || comparison;
    if (comparison && one) || (comparison_request && !all) {
        return None;
    }
    if (restrict_names
        && (names.len() < 2
            || phrases(
                &text,
                &[
                    "for example",
                    "for instance",
                    "such as",
                    "bijvoorbeeld",
                    "zoals",
                ],
            )))
        || (!all && !names.is_empty())
    {
        return None;
    }
    let mut requested_guidance = false;
    if comparison {
        let roles = corpus
            .activities
            .iter()
            .filter(|activity| names.contains(&activity.id))
            .fold(text.clone(), |query, activity| {
                query.replace(&activity.title.to_lowercase(), "")
            });
        let roles = self::words(&roles).collect::<Vec<_>>().join(" ");
        requested_guidance = phrases(
            &roles,
            &[
                "who guides",
                "who leads",
                "who helps",
                "who supports",
                "wie begeleidt",
                "wie helpt",
                "wie ondersteunt",
                "what support",
                "what help",
                "which support",
                "kind of support",
                "kind of help",
                "welke ondersteuning",
                "welke begeleiding",
                "welke hulp",
            ],
        );
        if phrases(&roles, &["only with", "but only", "alleen met"])
            || self::words(&roles).any(|word| {
                matches!(
                    word,
                    "language"
                        | "taal"
                        | "taalniveau"
                        | "nederlands"
                        | "experience"
                        | "ervaring"
                        | "accessibility"
                        | "toegankelijkheid"
                        | "medical"
                        | "medisch"
                        | "if"
                        | "unless"
                        | "als"
                        | "tenzij"
                ) || (!requested_guidance
                    && matches!(
                        word,
                        "help"
                            | "hulp"
                            | "support"
                            | "ondersteuning"
                            | "guidance"
                            | "begeleiding"
                            | "assistance"
                    ))
            })
        {
            return None;
        }
    }

    let mut matched_addresses = addresses(&words);
    let address = matched_addresses.next();
    if matched_addresses.next().is_some() {
        return None;
    }
    let free = (has(&words, &["gratis", "kosteloos"])
        || phrases(
            &text,
            &[
                "free of charge",
                "is free",
                "are free",
                "free activity",
                "free activities",
                "cost nothing",
                "costs nothing",
                "no participation fee",
            ],
        ))
        && !phrases(&text, &["free places", "free spots", "gratis parkeren"]);
    let supplied = has(
        &words,
        &[
            "materiaal",
            "materialen",
            "materials",
            "equipment",
            "supplies",
        ],
    ) && (has(&words, &["aanwezig", "provided", "supplied"])
        || phrases(
            &text,
            &["geen materiaal", "materials included", "already there"],
        ));

    if days.is_empty()
        && environment.is_none()
        && time.is_none()
        && !free
        && !supplied
        && address.is_none()
        && !comparison
    {
        return None;
    }

    let fields = Fields {
        description: phrases(
            &text,
            &[
                "wat je daar doet",
                "wat je er doet",
                "wat je doet",
                "wat we doen",
                "wat doe je",
                "wat je kunt doen",
                "wat doen",
                "what you do",
                "what they do",
                "what happens",
                "what to do",
            ],
        ) || !all,
        schedule: !days.is_empty()
            || time.is_some()
            || has(
                &words,
                &[
                    "dag",
                    "dagen",
                    "tijd",
                    "tijden",
                    "tijdstip",
                    "tijdstippen",
                    "wanneer",
                    "begintijd",
                    "eindtijd",
                    "hoelaat",
                    "day",
                    "days",
                    "time",
                    "times",
                    "when",
                    "schedule",
                    "start",
                    "end",
                ],
            )
            || phrases(&text, &["hoe laat"])
            || (comparison && has(&words, &["hours", "uren"])),
        place: environment.is_some()
            || address.is_some()
            || has(
                &words,
                &[
                    "waar",
                    "where",
                    "plek",
                    "locatie",
                    "locaties",
                    "verzamelplek",
                    "verzamelpunt",
                    "ontmoetingsplek",
                    "adres",
                    "address",
                    "location",
                    "place",
                    "venue",
                ],
            )
            || phrases(&text, &["meeting point", "meeting place"]),
        supplies: free
            || supplied
            || has(
                &words,
                &[
                    "kosten",
                    "cost",
                    "price",
                    "materiaal",
                    "materialen",
                    "materials",
                    "equipment",
                ],
            )
            || phrases(
                &text,
                &[
                    "what to bring",
                    "should bring",
                    "should i bring",
                    "need to bring",
                    "wat neem",
                    "wat moet ik mee",
                    "wat moet je mee",
                    "wat moeten we mee",
                ],
            )
            || (comparison && has(&words, &["bring", "meenemen"])),
        guidance: requested_guidance,
    };
    if comparison
        && !(fields.description
            || fields.schedule
            || fields.place
            || fields.supplies
            || fields.guidance)
    {
        return None;
    }
    Some(Intake {
        all,
        days,
        environment,
        time,
        free,
        supplied,
        address,
        fields,
        names,
        restrict_names,
    })
}

fn role_sections<'a>(sections: &[&'a Section], field: fn(&str) -> bool) -> Vec<&'a Section> {
    sections
        .iter()
        .copied()
        .filter(|section| field(&section.heading.to_lowercase()))
        .collect()
}

fn place(section: &str) -> bool {
    section == "waar?"
}

fn supplies(section: &str) -> bool {
    matches!(section, "kosten en materiaal" | "wat neem je mee?")
}

fn guidance(section: &str) -> bool {
    section == "taal en hulp"
}

fn intake_venue_statement(sentence: &str) -> Option<Option<Environment>> {
    if let Some(value) = super::metadata::explicit_environment(sentence) {
        return Some(Some(value));
    }
    let sentence = sentence.trim().to_lowercase();
    let (action, place) = sentence.strip_prefix("we ")?.split_once(' ')?;
    if !matches!(action, "spelen" | "lezen" | "werken" | "zitten") {
        return None;
    }
    match place {
        "binnen" => Some(Some(Environment::Indoor)),
        "buiten" => Some(Some(Environment::Outdoor)),
        _ if words(place).any(|word| matches!(word, "binnen" | "buiten")) => Some(None),
        _ => None,
    }
}

fn intake_venue<'a>(sections: &[&'a Section]) -> (Option<Environment>, Vec<&'a Section>) {
    let mut value = None;
    let mut uncertainty = false;
    let mut evidence = Vec::new();
    for &section in sections {
        let mut stated = false;
        for venue in section
            .text
            .split(['.', '!', '?'])
            .filter_map(intake_venue_statement)
        {
            stated = true;
            if let Some(venue) = venue {
                uncertainty |= value.is_some_and(|prior| prior != venue);
                value = Some(venue);
            } else {
                uncertainty = true;
            }
        }
        if stated {
            evidence.push(section);
        }
    }
    (value.filter(|_| !uncertainty), evidence)
}

fn explicit_fee(section: &str) -> Option<bool> {
    let mut states = BTreeSet::new();
    for sentence in section.to_lowercase().split(['.', '!', '?']).map(str::trim) {
        if matches!(
            sentence,
            "deelname is gratis"
                | "deelname is gratis en vrijwillig"
                | "deelname kost niets"
                | "deelname kost niets en is vrijwillig"
        ) {
            states.insert(true);
        } else if matches!(sentence, "deelname is betaald" | "deelname is niet gratis")
            || sentence.strip_prefix("deelname kost ").is_some_and(|fee| {
                fee.split_whitespace()
                    .next()
                    .is_some_and(|value| value.parse::<u16>().is_ok())
            })
        {
            states.insert(false);
        }
    }
    (states.len() == 1).then(|| *states.first().expect("one fee state"))
}

fn explicit_materials(section: &str) -> Option<bool> {
    let mut supplied = false;
    let mut brought = false;
    for sentence in section.to_lowercase().split(['.', '!', '?']).map(str::trim) {
        let declaration = sentence
            .strip_suffix(" zijn aanwezig")
            .or_else(|| sentence.strip_suffix(" is aanwezig"));
        supplied |= declaration.is_some_and(|subject| {
            !phrases(
                subject,
                &["niet", "als ", "wanneer", "soms", "mogelijk", "misschien"],
            ) && self::words(subject).any(|word| word != "er")
        }) || matches!(
            sentence,
            "je hoeft zelf geen materiaal mee te nemen" | "je hoeft zelf niets mee te nemen"
        );
        if !phrases(
            sentence,
            &["hoeft", "mag ", "is optioneel", "als ", "eventueel"],
        ) {
            brought |= (phrases(
                sentence,
                &[
                    "neem zelf ",
                    "neem je zelf ",
                    "zelf meenemen",
                    "zelf bij je hebben",
                    "eigen materiaal",
                ],
            ) && !phrases(
                sentence,
                &[
                    "water mee",
                    "eten mee",
                    "drinken mee",
                    "kleding mee",
                    "schoenen mee",
                ],
            )) || phrases(
                sentence,
                &[
                    "materiaal is niet aanwezig",
                    "materialen zijn niet aanwezig",
                ],
            );
        }
    }
    if brought {
        Some(false)
    } else if supplied {
        Some(true)
    } else {
        None
    }
}

fn check_time(time: Time, schedule: &super::Schedule) -> bool {
    let start = schedule.time.start_minutes;
    let end = schedule.time.end_minutes;
    match time {
        Time::StartsAt(at) => start == at,
        Time::ActiveAt(at) => start <= at && at < end,
        Time::Before(at) => start < at,
        Time::Afternoon => start < 18 * 60 && end > 12 * 60,
        Time::Morning => start < 12 * 60 && end > 6 * 60,
    }
}

#[derive(PartialEq)]
enum Eligibility {
    Match,
    Unknown,
    Excluded,
    DifferentStart,
}

fn eligibility(
    intake: &Intake,
    activity: &ActivityRecord,
    sections: &[&Section],
    venue: Option<Environment>,
) -> Eligibility {
    let mut checks = Vec::new();
    let mut different_start = false;
    if !intake.days.is_empty() || intake.time.is_some() {
        checks.push(activity.schedule.as_ref().map(|schedule| {
            let time_matches = intake
                .time
                .is_none_or(|time| check_time(time, &schedule.value));
            different_start = !time_matches && matches!(intake.time, Some(Time::StartsAt(_)));
            (intake.days.is_empty()
                || schedule
                    .value
                    .weekdays
                    .iter()
                    .any(|day| intake.days.contains(day)))
                && (time_matches || different_start)
        }));
    }
    if let Some(environment) = intake.environment {
        checks.push(venue.map(|fact| fact == environment));
    }
    if let Some(address) = &intake.address {
        let places = role_sections(sections, place);
        let coordinates: Vec<_> = places
            .iter()
            .flat_map(|section| {
                let text = section.text.to_lowercase();
                addresses(&words(&text).collect::<Vec<_>>()).collect::<Vec<_>>()
            })
            .collect();
        checks.push((!coordinates.is_empty()).then(|| coordinates.contains(address)));
    }
    let supplies = role_sections(sections, supplies);
    if intake.free {
        checks.push(
            supplies
                .first()
                .and_then(|section| explicit_fee(&section.text)),
        );
    }
    if intake.supplied {
        checks.push(
            supplies
                .first()
                .and_then(|section| explicit_materials(&section.text)),
        );
    }

    let unknown = checks.contains(&None);
    if checks.contains(&Some(false)) || (different_start && unknown) {
        Eligibility::Excluded
    } else if unknown {
        Eligibility::Unknown
    } else if different_start {
        Eligibility::DifferentStart
    } else {
        Eligibility::Match
    }
}

fn evidence_bundle<'a>(
    intake: &Intake,
    activity: &ActivityRecord,
    sections: &[&'a Section],
    venue_evidence: &[&Section],
) -> (Vec<&'a Section>, bool) {
    let schedule_keys: BTreeSet<_> = activity
        .schedule
        .iter()
        .flat_map(|source| source.evidence.iter().map(|fact| fact.section_id.as_str()))
        .collect();
    let mut bundle: Vec<_> = sections
        .iter()
        .copied()
        .filter(|section| {
            let heading = section.heading.to_lowercase();
            let fields = &intake.fields;
            (fields.description && heading.starts_with("wat doen"))
                || (fields.schedule
                    && (heading == "wanneer?" || schedule_keys.contains(section.id.as_str())))
                || (fields.place && place(&heading))
                || venue_evidence
                    .iter()
                    .any(|evidence| evidence.id == section.id)
                || (fields.supplies && supplies(&heading))
                || (fields.guidance && guidance(&heading))
        })
        .collect();
    bundle.sort_by(|left, right| left.id.cmp(&right.id));
    let fields = &intake.fields;
    let has_heading = |role: fn(&str) -> bool| {
        bundle
            .iter()
            .any(|section| role(&section.heading.to_lowercase()))
    };
    let complete = (!fields.description || has_heading(|heading| heading.starts_with("wat doen")))
        && (!fields.schedule
            || bundle.iter().any(|section| {
                section.heading.eq_ignore_ascii_case("wanneer?")
                    || schedule_keys.contains(section.id.as_str())
            }))
        && (!fields.place || has_heading(place))
        && (!fields.supplies || has_heading(supplies))
        && (!fields.guidance || has_heading(guidance));
    (bundle, complete)
}

pub(crate) fn apply_intake_policy(
    corpus: &PreparedCorpus,
    baseline: &RetrievalOutcome,
) -> (RetrievalOutcome, IntakeDecision) {
    let Some(intake) = read_intake(corpus, &baseline.query) else {
        return (baseline.clone(), IntakeDecision::default());
    };
    let mut decision = IntakeDecision {
        applied: true,
        ..Default::default()
    };
    let mut matches = Vec::new();
    let mut contextual = Vec::new();
    let mut counterexamples = Vec::new();
    let mut has_requested_evidence = true;
    for activity in &corpus.activities {
        let named = intake.names.contains(&activity.id);
        if intake.restrict_names && !named {
            continue;
        }
        let sections: Vec<_> = corpus
            .sections
            .iter()
            .filter(|section| section.source_id == activity.id)
            .collect();
        let (venue, venue_evidence) = if intake.environment.is_some() {
            intake_venue(&sections)
        } else {
            (None, Vec::new())
        };
        let eligibility = eligibility(&intake, activity, &sections, venue);
        let (bundle, complete) = evidence_bundle(&intake, activity, &sections, &venue_evidence);
        match eligibility {
            Eligibility::Match => {
                has_requested_evidence &= complete;
                matches.push((activity, bundle));
            }
            Eligibility::Unknown => {
                decision.unknown.push(activity.id.clone());
                contextual.push(bundle);
            }
            Eligibility::Excluded | Eligibility::DifferentStart if named => {
                has_requested_evidence &= complete;
                contextual.push(bundle);
            }
            Eligibility::DifferentStart if intake.all => {
                let schedule = activity.schedule.as_ref().expect("known start time");
                counterexamples.push(
                    sections
                        .into_iter()
                        .filter(|section| {
                            schedule
                                .evidence
                                .iter()
                                .any(|fact| fact.section_id == section.id)
                        })
                        .collect(),
                );
            }
            Eligibility::Excluded | Eligibility::DifferentStart => {}
        }
    }

    if !intake.all {
        if matches.is_empty() {
            return (baseline.clone(), IntakeDecision::default());
        }
        matches.sort_by_key(|(activity, _)| {
            baseline
                .candidates
                .iter()
                .position(|candidate| candidate.key.source_id == activity.id)
                .unwrap_or(usize::MAX)
        });
        matches.truncate(1);
    }

    decision.matches = matches
        .iter()
        .map(|(activity, _)| activity.id.clone())
        .collect();
    let mut outcome = baseline.clone();
    outcome.hits.clear();
    outcome.omitted.clear();
    outcome.estimated_context_tokens = 0;
    for (bundle, required) in matches
        .into_iter()
        .map(|(_, bundle)| bundle)
        .chain(contextual)
        .map(|bundle| (bundle, true))
        .chain(counterexamples.into_iter().map(|bundle| (bundle, false)))
    {
        let size: usize = bundle
            .iter()
            .map(|section| estimate_section_tokens(section))
            .sum();
        if outcome.estimated_context_tokens + size > outcome.config.context_token_limit {
            if required {
                outcome
                    .omitted
                    .extend(bundle.into_iter().map(|section| {
                        ContextOmission {
                            key: SectionKey::from(section),
                            reason:
                                "Complete activity evidence bundle exceeds remaining context budget"
                                    .into(),
                        }
                    }));
            }
            continue;
        }
        outcome.estimated_context_tokens += size;
        outcome.hits.extend(bundle.into_iter().map(|section| {
            let key = SectionKey::from(section);
            RetrievalHit {
                section: section.clone(),
                scores: baseline
                    .candidates
                    .iter()
                    .find(|candidate| candidate.key == key)
                    .map(|candidate| candidate.scores.clone()),
                inclusion: if baseline.seeds.contains(&key) {
                    Inclusion::Seed
                } else {
                    Inclusion::ActivityExpansion
                },
            }
        }));
    }
    // Keep seed order aligned with the delivered hit order after constrained selection.
    outcome.seeds = outcome
        .hits
        .iter()
        .filter(|hit| hit.inclusion == Inclusion::Seed)
        .map(|hit| SectionKey::from(&hit.section))
        .collect();
    decision.exhaustive = intake.all
        && has_requested_evidence
        && decision.unknown.is_empty()
        && outcome.omitted.is_empty();
    (outcome, decision)
}

#[cfg(test)]
mod tests {
    use super::super::{RetrievalConfig, RetrievalRequest, SearchMethod, SelectionMode, retrieve};
    use super::*;
    use crate::corpus::CorpusId;

    fn corpus() -> PreparedCorpus {
        let sections = CorpusId::DemoTwelve
            .sources()
            .unwrap()
            .into_iter()
            .flat_map(|source| source.sections)
            .collect();
        PreparedCorpus::new(sections, None, None).unwrap()
    }

    fn search(
        corpus: &PreparedCorpus,
        query: &str,
        budget: usize,
    ) -> (RetrievalOutcome, IntakeDecision) {
        let reference = retrieve(
            corpus,
            &RetrievalRequest {
                query: query.into(),
                filters: Default::default(),
            },
            &RetrievalConfig {
                method: SearchMethod::Bm25,
                selection: SelectionMode::ActivityExpansion,
                context_token_limit: budget,
                ..Default::default()
            },
            None,
        )
        .unwrap();
        apply_intake_policy(corpus, &reference)
    }

    #[test]
    fn exhaustive_clock_question_returns_every_activity_with_the_needed_sections() {
        let (outcome, decision) = search(
            &corpus(),
            "Welke binnenactiviteiten zijn om 14.15 uur bezig? Geef alle opties met dag en locatie.",
            1200,
        );
        assert!(decision.applied && decision.exhaustive, "{decision:?}");
        assert_eq!(decision.matches.len(), 4);
        assert!(decision.unknown.is_empty());
        assert_eq!(outcome.hits.len(), 8);
        assert!(
            outcome
                .hits
                .iter()
                .all(|hit| ["S2", "S3"].contains(&hit.section.id.as_str()))
        );
        assert_eq!(outcome.estimated_context_tokens, 402);
    }

    #[test]
    fn exact_start_does_not_mean_active_at_that_time() {
        let corpus = corpus();
        let (_, active) = search(
            &corpus,
            "Which indoor activities are running at 14:00? Give all options.",
            1200,
        );
        let (_, start) = search(
            &corpus,
            "Which indoor activities start at 14:00? Give all options.",
            1200,
        );
        assert_eq!(active.matches.len(), 4);
        assert_eq!(start.matches.len(), 2);
        assert!(start.matches.iter().all(|id| active.matches.contains(id)));
    }

    #[test]
    fn an_exact_start_can_include_the_weekday_before_the_clock() {
        let (outcome, decision) = search(
            &corpus(),
            "Welke binnenactiviteiten beginnen op donderdag precies om 13.00 uur? Noem alle passende opties met locatie en eindtijd.",
            1200,
        );
        assert!(decision.applied && decision.exhaustive, "{decision:?}");
        assert_eq!(decision.matches.len(), 1);
        assert_eq!(outcome.hits.len(), 2);
        assert!(
            outcome
                .hits
                .iter()
                .all(|hit| hit.section.source_title == "Naaicafé")
        );
    }

    #[test]
    fn an_active_at_filter_can_include_a_weekday_and_explicit_time_phrase() {
        let (_, decision) = search(
            &corpus(),
            "Which indoor activities are running on Tuesday at exactly 14:30? Give all options.",
            1200,
        );
        assert!(decision.applied && decision.exhaustive, "{decision:?}");
        assert_eq!(decision.matches.len(), 2);
    }

    #[test]
    fn a_fronted_clock_can_bind_to_a_later_start_predicate_in_the_same_clause() {
        let (_, decision) = search(
            &corpus(),
            "At 10:00 on Friday, which outdoor activities start? List every option.",
            1200,
        );
        assert!(decision.applied && decision.exhaustive, "{decision:?}");
        assert_eq!(decision.matches.len(), 1);
    }

    #[test]
    fn a_fronted_clock_cannot_borrow_a_predicate_from_another_clause() {
        let (_, decision) = search(
            &corpus(),
            "Welke buitenactiviteiten op vrijdag, om 10.00 uur? Beginnen doet er niet toe.",
            1200,
        );
        assert!(!decision.applied, "{decision:?}");
    }

    #[test]
    fn a_separable_dutch_start_expression_remains_an_exact_start() {
        let (_, decision) = search(
            &corpus(),
            "Welke buitenactiviteiten gaan op vrijdag om 10.00 uur van start?",
            1200,
        );
        assert!(decision.applied && decision.exhaustive, "{decision:?}");
        assert_eq!(decision.matches.len(), 1);
    }

    #[test]
    fn progressive_english_predicates_match_ongoing_activities() {
        let corpus = corpus();
        for predicate in ["in progress", "taking place"] {
            let (_, decision) = search(
                &corpus,
                &format!("Which indoor activities are {predicate} at 14:15? Give all options."),
                1200,
            );
            assert!(
                decision.applied && decision.exhaustive,
                "{predicate}: {decision:?}"
            );
            assert_eq!(decision.matches.len(), 4);
        }
    }

    #[test]
    fn negating_a_progressive_phrase_keeps_the_baseline() {
        let corpus = corpus();
        for question in [
            "Which indoor activities are not in progress at 14:15? Give all options.",
            "Which indoor activities are no longer in progress at 14:15? Give all options.",
            "Which indoor activities are no longer taking place at 14:15? Give all options.",
            "Welke activiteiten zijn niet meer binnen bezig om 14.15 uur? Geef alle opties.",
        ] {
            let (_, decision) = search(&corpus, question, 1200);
            assert!(!decision.applied, "{question}");
        }
    }

    #[test]
    fn an_explicit_play_venue_counts_in_the_intake_route() {
        let corpus = corpus();
        let (outcome, decision) = search(
            &corpus,
            "Welke binnenactiviteiten zijn op woensdag om 16.30 uur bezig? Geef alle opties met locatie.",
            1200,
        );
        assert!(decision.applied && decision.exhaustive, "{decision:?}");
        assert_eq!(decision.matches.len(), 1);
        assert_eq!(outcome.hits.len(), 2);
        assert!(
            outcome
                .hits
                .iter()
                .all(|hit| hit.section.source_title == "Schaken")
        );
    }

    #[test]
    fn conflicting_or_conditional_venue_wording_stays_unknown() {
        for statement in [
            "We spelen binnen. We spelen buiten.",
            "We spelen binnen als het regent.",
            "We spelen binnen. We spelen niet binnen.",
        ] {
            let mut sections = corpus().sections;
            let place = sections
                .iter_mut()
                .find(|section| section.source_title == "Schaken" && section.id == "S3")
                .unwrap();
            place.text = statement.into();
            let source_id = place.source_id.clone();
            let corpus = PreparedCorpus::new(sections, None, None).unwrap();
            let (_, decision) = search(
                &corpus,
                "Welke binnenactiviteiten zijn op woensdag om 16.30 uur bezig? Geef alle opties met locatie.",
                1200,
            );
            assert!(
                !decision.exhaustive && decision.matches.is_empty(),
                "{statement}"
            );
            assert_eq!(decision.unknown, vec![source_id]);
        }
    }

    #[test]
    fn a_clock_can_precede_the_location_and_active_predicate() {
        let (_, decision) = search(
            &corpus(),
            "Welke activiteiten zijn om 14.15 uur binnen bezig? Noem alle opties.",
            1200,
        );
        assert!(decision.applied && decision.exhaustive, "{decision:?}");
        assert_eq!(decision.matches.len(), 4);
    }

    #[test]
    fn a_negated_start_is_not_reported_as_an_exact_start_match() {
        let (_, decision) = search(
            &corpus(),
            "Which indoor activities do not start at 14:00? Give all options.",
            1200,
        );
        assert!(!decision.applied);
        assert!(!decision.exhaustive);
    }

    #[test]
    fn a_contracted_english_negation_stays_out_of_exhaustive_matching() {
        let (_, decision) = search(
            &corpus(),
            "Which indoor activities don't start at 14:00? Give all options.",
            1200,
        );
        assert!(!decision.applied);
        assert!(!decision.exhaustive);
    }

    #[test]
    fn a_clock_with_an_open_ended_alternative_cannot_be_exact() {
        let (_, decision) = search(
            &corpus(),
            "Which indoor activities start at 14:00 or later? Give all options.",
            1200,
        );
        assert!(!decision.applied);
        assert!(!decision.exhaustive);
    }

    #[test]
    fn asking_for_start_time_does_not_override_an_active_at_filter() {
        let (_, decision) = search(
            &corpus(),
            "Which indoor activities are running at 15:05? List each and its start time.",
            1200,
        );
        assert!(decision.applied && decision.exhaustive, "{decision:?}");
        assert_eq!(decision.matches.len(), 3);
    }

    #[test]
    fn a_soft_preference_never_becomes_an_exhaustive_filter() {
        let (_, decision) = search(
            &corpus(),
            "Ik zoek iets om woensdag te doen, liefst binnen.",
            1200,
        );
        assert!(!decision.applied);
        assert!(!decision.exhaustive);
    }

    #[test]
    fn an_unsupported_clock_format_does_not_silently_drop_the_time_filter() {
        let (_, decision) = search(
            &corpus(),
            "Which indoor activities start at 2 p.m.? List all of them.",
            1200,
        );
        assert!(!decision.applied);
        assert!(!decision.exhaustive);
    }

    #[test]
    fn an_invalid_clock_is_not_silently_dropped_from_the_filter() {
        let (_, decision) = search(
            &corpus(),
            "Welke binnenactiviteiten beginnen op donderdag om 26:00? Noem alle opties.",
            1200,
        );
        assert!(!decision.applied);
        assert!(!decision.exhaustive);
    }

    #[test]
    fn a_resident_being_free_does_not_mean_participation_must_be_free() {
        let mut sections = corpus().sections;
        let section = sections
            .iter_mut()
            .find(|section| section.source_title == "Creatief atelier" && section.id == "S5")
            .unwrap();
        section.text = "Deelname kost 3 euro. Papier en verf zijn aanwezig.".into();
        let corpus = PreparedCorpus::new(sections, None, None).unwrap();
        let (_, available) = search(
            &corpus,
            "I am free on Tuesday. Which indoor activities can I do that day?",
            1200,
        );
        let (_, no_cost) = search(
            &corpus,
            "Which indoor activities are free of charge on Tuesday?",
            1200,
        );
        assert_eq!(available.matches.len(), 2);
        assert_eq!(no_cost.matches.len(), 1);
    }

    #[test]
    fn a_single_option_can_be_requested_for_a_residents_free_day() {
        let corpus = corpus();
        let (outcome, decision) = search(
            &corpus,
            "Ik ben op dinsdag vrij en wil meedoen. Noem één activiteit en zeg wat ik er doe, hoe laat die is en waar ik moet zijn.",
            1200,
        );
        assert!(decision.applied && !decision.exhaustive, "{decision:?}");
        assert_eq!(decision.matches.len(), 1);
        assert_eq!(outcome.hits.len(), 3);
        assert!(
            outcome
                .hits
                .iter()
                .all(|hit| hit.section.source_id == decision.matches[0])
        );
        let schedule = outcome
            .hits
            .iter()
            .find(|hit| hit.section.id == "S2")
            .unwrap();
        assert!(schedule.section.text.contains("dinsdag"));
    }

    #[test]
    fn a_residents_clock_filters_ongoing_options_and_relevance_picks_one() {
        let corpus = corpus();
        for question in [
            "Ik ben op dinsdag om 14.15 uur vrij en wil binnen iets praktisch doen: fietsen repareren. Noem één passende activiteit en zeg wat ik er doe, hoe laat die is en waar ik moet zijn.",
            "I can attend on Tuesday at 14:15. Give one indoor option for fixing bikes with its schedule and address.",
        ] {
            let (outcome, decision) = search(&corpus, question, 1200);
            assert!(decision.applied && !decision.exhaustive, "{decision:?}");
            assert_eq!(decision.matches.len(), 1);
            assert_eq!(outcome.hits.len(), 3);
            assert!(
                outcome
                    .hits
                    .iter()
                    .all(|hit| hit.section.source_title == "Fietsen opknappen")
            );
        }
    }

    #[test]
    fn a_residents_unavailability_does_not_become_a_positive_constraint() {
        let corpus = corpus();
        for question in [
            "Ik ben op dinsdag niet vrij. Noem één activiteit met tijd en plek.",
            "Ik kan zaterdag niet. Noem één activiteit met tijd en plek.",
            "I cannot attend on Saturday. Suggest one activity with its schedule and location.",
            "I can't attend on Saturday. Give me one activity with its schedule and location.",
            "I can attend Saturday but not in the morning. Give one activity with schedule and location.",
        ] {
            let (_, decision) = search(&corpus, question, 1200);
            assert!(!decision.applied && !decision.exhaustive, "{question}");
        }
    }

    #[test]
    fn negation_in_an_equipment_statement_does_not_reject_a_residents_day() {
        let (_, decision) = search(
            &corpus(),
            "I can attend Saturday. Suggest one activity. I don't need to bring my own equipment.",
            1200,
        );
        assert!(decision.applied && !decision.exhaustive, "{decision:?}");
        assert_eq!(decision.matches.len(), 1);
    }

    #[test]
    fn an_exact_time_near_miss_supplies_only_its_schedule_as_counterevidence() {
        let mut sections = corpus().sections;
        let schedule = sections
            .iter_mut()
            .find(|section| section.source_title == "Taalcafé" && section.id == "S2")
            .unwrap();
        schedule.text = schedule.text.replace("14.00", "14.30");
        let corpus = PreparedCorpus::new(sections, None, None).unwrap();
        let (outcome, decision) = search(
            &corpus,
            "Welke gratis binnenactiviteiten beginnen precies om 14.30 uur en hebben materiaal aanwezig? Noem alle opties met dag, eindtijd, plek en wat je daar doet.",
            1200,
        );
        assert!(decision.applied && decision.exhaustive, "{decision:?}");
        assert_eq!(decision.matches.len(), 1);
        let bike_hits: Vec<_> = outcome
            .hits
            .iter()
            .filter(|hit| hit.section.source_title == "Fietsen opknappen")
            .collect();
        assert_eq!(bike_hits.len(), 1);
        assert_eq!(bike_hits[0].section.id, "S2");
        assert!(!decision.matches.contains(&bike_hits[0].section.source_id));
        assert_eq!(outcome.hits[0].section.source_title, "Taalcafé");
        assert!(outcome.estimated_context_tokens <= 1200);
    }

    #[test]
    fn missing_environment_does_not_confirm_eligibility() {
        let mut sections = corpus().sections;
        let section = sections
            .iter_mut()
            .find(|section| section.source_title == "Taalcafé" && section.id == "S3")
            .unwrap();
        section.text = "Locatiegegevens staan niet in deze beschrijving.".into();
        let unknown_id = section.source_id.clone();
        let corpus = PreparedCorpus::new(sections, None, None).unwrap();
        let (outcome, decision) = search(
            &corpus,
            "Welke binnenactiviteiten beginnen om 14.00 uur? Geef alle opties en vermeld onbekende informatie.",
            1200,
        );
        assert_eq!(decision.unknown, std::slice::from_ref(&unknown_id));
        assert!(!decision.matches.contains(&unknown_id));
        assert!(!decision.exhaustive);
        assert!(
            outcome
                .hits
                .iter()
                .any(|hit| hit.section.source_id == unknown_id && hit.section.id == "S3")
        );
    }

    #[test]
    fn the_same_address_returns_both_schedule_and_location_bundles() {
        let (outcome, decision) = search(
            &corpus(),
            "Welke activiteiten zijn er op Esdoornstraat 8? Geef ze allemaal met dag en plek.",
            1200,
        );
        assert!(decision.applied && decision.exhaustive, "{decision:?}");
        assert_eq!(decision.matches.len(), 2);
        assert_eq!(outcome.hits.len(), 4);
    }

    #[test]
    fn a_named_comparison_delivers_meeting_and_bringing_details_for_both_sources() {
        let (outcome, decision) = search(
            &corpus(),
            "Compare Tuinieren and Wandelen. Give each meeting point and what to bring.",
            1200,
        );
        assert!(decision.applied && decision.exhaustive, "{decision:?}");
        assert_eq!(decision.matches.len(), 2);
        assert_eq!(outcome.hits.len(), 4);
        for title in ["Tuinieren", "Wandelen"] {
            let sections: Vec<_> = outcome
                .hits
                .iter()
                .filter(|hit| hit.section.source_title == title)
                .map(|hit| hit.section.id.as_str())
                .collect();
            assert_eq!(sections, ["S3", "S5"], "{title}");
        }
    }

    #[test]
    fn a_named_comparison_with_unhandled_language_support_keeps_ranked_evidence() {
        let (_, decision) = search(
            &corpus(),
            "Compare Tuinieren and Wandelen by their meeting point and English language support.",
            1200,
        );
        assert!(!decision.applied, "{decision:?}");
    }

    #[test]
    fn closed_named_subsets_supply_positive_and_negative_schedule_evidence() {
        let corpus = corpus();
        for query in [
            "Which of Tuinieren and Wandelen takes place on Thursday? Give the time and place.",
            "Van Tuinieren en Wandelen, welke vindt plaats op donderdag? Geef tijd en plek.",
        ] {
            let (outcome, decision) = search(&corpus, query, 1200);
            assert!(
                decision.applied && decision.exhaustive,
                "{query}: {decision:?}"
            );
            assert_eq!(decision.matches, ["ACT-WANDEL-005"]);
            assert_eq!(outcome.hits.len(), 4);
            assert!(
                outcome.hits.iter().any(|hit| {
                    hit.section.source_title == "Tuinieren" && hit.section.id == "S2"
                })
            );
        }
        let (_, decision) = search(
            &corpus,
            "Which outdoor activities are running Thursday at 10:00? Tuinieren and Parkonderhoud are just examples.",
            1200,
        );
        assert_eq!(decision.matches, ["ACT-WANDEL-005"]);
    }

    #[test]
    fn underway_uses_the_activity_window_without_discarding_negation() {
        let corpus = corpus();
        let (_, underway) = search(
            &corpus,
            "Which outdoor activities are underway at 10:00 on Thursday? Give all with their meeting point.",
            1200,
        );
        assert!(underway.applied && underway.exhaustive, "{underway:?}");
        assert_eq!(underway.matches, ["ACT-WANDEL-005"]);

        for phrase in ["not underway at", "no longer underway at"] {
            let (_, negated) = search(
                &corpus,
                &format!("Which outdoor activities are {phrase} 10:00 on Thursday?"),
                1200,
            );
            assert!(!negated.applied, "{phrase}: {negated:?}");
        }
        let (_, starts) = search(
            &corpus,
            "Which outdoor activities start at 10:00 on Thursday? Give all options.",
            1200,
        );
        assert!(starts.applied && starts.exhaustive);
        assert!(starts.matches.is_empty());
    }

    #[test]
    fn named_weekly_hours_meeting_points_and_guides_deliver_all_requested_roles() {
        let corpus = corpus();
        let (outcome, decision) = search(
            &corpus,
            "Compare Tuinieren and Wandelen. Give their weekly hours, meeting points and who guides participants.",
            1200,
        );
        assert!(decision.applied && decision.exhaustive, "{decision:?}");
        for title in ["Tuinieren", "Wandelen"] {
            let references: Vec<_> = outcome
                .hits
                .iter()
                .filter(|hit| hit.section.source_title == title)
                .map(|hit| hit.section.id.as_str())
                .collect();
            assert_eq!(references, ["S2", "S3", "S4"], "{title}");
        }
        let (_, conditional) = search(
            &corpus,
            "Compare Tuinieren and Wandelen by weekly hours and who guides participants, but only if I can receive personal support.",
            1200,
        );
        assert!(!conditional.applied, "{conditional:?}");
    }

    #[test]
    fn a_named_comparison_cannot_claim_missing_canonical_guidance_is_complete() {
        let mut sections = corpus().sections;
        sections.retain(|section| {
            section.source_title != "Wandelen" || section.heading != "Taal en hulp"
        });
        let corpus = PreparedCorpus::new(sections, None, None).unwrap();
        let (_, decision) = search(
            &corpus,
            "Compare Tuinieren and Wandelen. Give their times and who guides participants.",
            1200,
        );
        assert!(decision.applied);
        assert!(!decision.exhaustive, "{decision:?}");
    }

    #[test]
    fn bare_hours_in_a_named_comparison_request_schedule_evidence() {
        let (outcome, decision) = search(
            &corpus(),
            "Compare Tuinieren and Wandelen. Give their hours and meeting places.",
            1200,
        );
        assert!(decision.applied && decision.exhaustive, "{decision:?}");
        assert_eq!(
            outcome
                .hits
                .iter()
                .filter(|hit| hit.section.id == "S2")
                .count(),
            2
        );
    }

    #[test]
    fn illustrative_names_and_unsupported_conditions_cannot_claim_a_closed_comparison() {
        let corpus = corpus();
        for query in [
            "Which of these activities are on Thursday? For example Tuinieren and Parkonderhoud. List all options with times and places.",
            "Compare Tuinieren and Wandelen. Give their weekly hours and who guides them if their needs change.",
            "Which of Tuinieren and Wandelen plus Parkonderhoud runs on Thursday? Give each meeting point.",
            "Which of Tuinieren and Wandelen, including Parkonderhoud, runs on Thursday? Give each meeting point.",
        ] {
            let (_, decision) = search(&corpus, query, 1200);
            assert!(!decision.applied, "{query}: {decision:?}");
        }
    }

    #[test]
    fn bringing_questions_request_a_source_passage_without_a_named_comparison() {
        let corpus = corpus();
        for wording in ["what I should bring", "what do I need to bring"] {
            let (outcome, decision) = search(
                &corpus,
                &format!(
                    "Which outdoor activities are running Friday at 10:30? Give all options and {wording}."
                ),
                1200,
            );
            assert!(decision.applied && decision.exhaustive, "{decision:?}");
            assert_eq!(decision.matches.len(), 1);
            assert!(
                outcome.hits.iter().any(|hit| hit.section.id == "S5"),
                "{wording}"
            );
        }
    }

    #[test]
    fn a_context_limit_keeps_whole_bundles_and_reports_a_partial_list() {
        let (outcome, decision) = search(
            &corpus(),
            "Welke binnenactiviteiten zijn om 14.15 uur bezig? Geef alle opties met dag en locatie.",
            270,
        );
        assert!(decision.applied);
        assert!(!decision.exhaustive);
        assert!(!outcome.omitted.is_empty());
        assert!(outcome.estimated_context_tokens <= 270);
        for activity in &decision.matches {
            let shown = outcome
                .hits
                .iter()
                .filter(|hit| hit.section.source_id == *activity)
                .count();
            assert!(shown == 0 || shown == 2);
        }
    }

    #[test]
    fn unrecognised_or_semantic_only_questions_retain_the_ranked_baseline() {
        let corpus = corpus();
        let query = "Wat kan ik doen bij het Taalcafé?";
        let (outcome, decision) = search(&corpus, query, 1200);
        assert!(!decision.applied);
        assert!(!decision.exhaustive);
        assert!(!outcome.hits.is_empty());
    }
}
