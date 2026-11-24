//! In-memory limits for the anonymous public demo; no visitor identifiers are logged.
use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, Ipv6Addr},
    sync::{Arc, Weak},
    time::{Duration, Instant},
};
const QUESTION_WINDOW: Duration = Duration::from_secs(3600);
const MAX_QUESTIONS_PER_IP: usize = 10;
const MAX_DEMO_QUESTIONS: usize = 100;
const SESSION_WINDOW: Duration = Duration::from_secs(600);
const COOLDOWN: Duration = Duration::from_secs(5);
const MAX_CLIENTS: usize = 4096;

#[derive(Debug, PartialEq)]
pub struct Blocked {
    pub retry_after_seconds: u64,
    pub code: &'static str,
    pub message: &'static str,
}
impl Blocked {
    fn until(code: &'static str, message: &'static str, remaining: Duration) -> Self {
        Self {
            retry_after_seconds: remaining
                .as_secs()
                .saturating_add(u64::from(remaining.subsec_nanos() > 0))
                .max(1),
            code,
            message,
        }
    }
}
#[derive(Default)]
struct Visitor {
    questions: VecDeque<Instant>,
    sessions: VecDeque<Instant>,
    last_question: HashMap<String, Instant>,
    active_question: Weak<()>,
}
#[derive(Default)]
pub struct DemoLimits {
    visitors: HashMap<IpAddr, Visitor>,
    demo_questions: VecDeque<Instant>,
}
impl DemoLimits {
    fn cleanup(&mut self, now: Instant) {
        self.demo_questions
            .retain(|at| now.duration_since(*at) < QUESTION_WINDOW);
        self.visitors.retain(|_, visitor| {
            visitor
                .questions
                .retain(|at| now.duration_since(*at) < QUESTION_WINDOW);
            visitor
                .sessions
                .retain(|at| now.duration_since(*at) < SESSION_WINDOW);
            visitor
                .last_question
                .retain(|_, at| now.duration_since(*at) < COOLDOWN);
            !visitor.questions.is_empty()
                || !visitor.sessions.is_empty()
                || visitor.active_question.strong_count() > 0
        });
    }
    fn check_capacity(&mut self, ip: IpAddr, now: Instant) -> Result<(), Blocked> {
        self.cleanup(now);
        if !self.visitors.contains_key(&ip) && self.visitors.len() >= MAX_CLIENTS {
            return Err(Blocked::until(
                "rate_limit",
                "De demo ontvangt veel bezoekers. Probeer het later opnieuw.",
                QUESTION_WINDOW,
            ));
        }
        Ok(())
    }
    pub fn check_run(&mut self, ip: IpAddr, session: &str, now: Instant) -> Result<(), Blocked> {
        self.check_capacity(ip, now)?;
        let visitor = self.visitors.get(&ip);
        // The demo queue includes every question from this IP, so its first
        // question expires at or before the first question from this IP.
        if let Some(visitor) = visitor
            && visitor.questions.len() >= MAX_QUESTIONS_PER_IP
        {
            return Err(Blocked::until(
                "ip_rate_limit",
                "Vanaf jouw netwerk zijn net veel vragen gesteld. Probeer het later nog eens.",
                QUESTION_WINDOW.saturating_sub(now.duration_since(visitor.questions[0])),
            ));
        }
        if self.demo_questions.len() >= MAX_DEMO_QUESTIONS {
            return Err(Blocked::until(
                "demo_rate_limit",
                "Het is even druk bij de demo. Probeer het later nog eens.",
                QUESTION_WINDOW.saturating_sub(now.duration_since(self.demo_questions[0])),
            ));
        }
        if let Some(visitor) = visitor {
            if let Some(at) = visitor.last_question.get(session) {
                return Err(Blocked::until(
                    "session_cooldown",
                    "Wacht vijf seconden tussen vragen.",
                    COOLDOWN.saturating_sub(now.duration_since(*at)),
                ));
            }
            if visitor.active_question.strong_count() > 0 {
                return Err(Blocked::until(
                    "visitor_busy",
                    "Er wordt al een vraag verwerkt vanaf jouw netwerk. Probeer het zo opnieuw.",
                    COOLDOWN,
                ));
            }
        }
        Ok(())
    }
    pub fn record_run(&mut self, ip: IpAddr, session: &str, now: Instant) -> Arc<()> {
        self.demo_questions.push_back(now);
        let visitor = self.visitors.entry(ip).or_default();
        // The run task owns the permit, so completion or cancellation releases it.
        let permit = Arc::new(());
        visitor.active_question = Arc::downgrade(&permit);
        visitor.questions.push_back(now);
        visitor.last_question.insert(session.to_owned(), now);
        permit
    }
    pub fn check_session(&mut self, ip: IpAddr, now: Instant) -> Result<(), Blocked> {
        self.check_capacity(ip, now)?;
        if let Some(visitor) = self.visitors.get(&ip)
            && visitor.sessions.len() >= 30
        {
            return Err(Blocked::until(
                "session_limit",
                "Je hebt te vaak opnieuw verbinding gemaakt. Probeer het later opnieuw.",
                SESSION_WINDOW.saturating_sub(now.duration_since(visitor.sessions[0])),
            ));
        }
        Ok(())
    }
    pub fn record_session(&mut self, ip: IpAddr, now: Instant) {
        self.visitors.entry(ip).or_default().sessions.push_back(now);
    }
}
/// Ignore all forwarded identities unless the real TCP peer is the configured proxy.
/// That proxy must overwrite X-Real-IP rather than pass through client input.
pub fn client_ip(
    peer: IpAddr,
    trusted_proxy: Option<IpAddr>,
    real_ip: Option<&str>,
) -> Result<IpAddr, &'static str> {
    let ip = if trusted_proxy == Some(peer) {
        real_ip
            .and_then(|value| value.parse::<IpAddr>().ok())
            .ok_or("Ongeldig bezoekersadres van de proxy.")?
    } else {
        peer
    };
    Ok(match ip {
        IpAddr::V6(address) => match address.to_ipv4_mapped() {
            Some(ipv4) => IpAddr::V4(ipv4),
            None => IpAddr::V6(Ipv6Addr::from((u128::from(address) >> 64) << 64)),
        },
        other => other,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    fn ip() -> IpAddr {
        "192.0.2.1".parse().unwrap()
    }
    #[test]
    fn new_sessions_cannot_bypass_ten_questions_per_hour() {
        let mut limits = DemoLimits::default();
        let now = Instant::now();
        for n in 0..10 {
            let session = format!("visitor-{n}");
            assert_eq!(limits.check_run(ip(), &session, now), Ok(()));
            limits.record_run(ip(), &session, now);
        }
        let blocked = limits.check_run(ip(), "new-session", now).unwrap_err();
        assert_eq!(blocked.code, "ip_rate_limit");
        assert_eq!(blocked.retry_after_seconds, 3600);
        assert_eq!(
            limits.check_run(ip(), "new-session", now + Duration::from_secs(3600)),
            Ok(())
        );
    }
    #[test]
    fn demo_wide_quota_releases_one_slot_at_a_time_as_questions_expire() {
        let mut limits = DemoLimits::default();
        let now = Instant::now();
        let later = now + Duration::from_secs(10);
        for n in 1..=100 {
            let address = IpAddr::from([192, 0, 2, n]);
            let at = if n == 1 { now } else { later };
            assert_eq!(limits.check_run(address, "one", at), Ok(()));
            limits.record_run(address, "one", at);
        }
        let next = IpAddr::from([192, 0, 2, 101]);
        let expiry = now + Duration::from_secs(3600);
        let blocked = limits
            .check_run(next, "one", expiry - Duration::from_millis(100))
            .unwrap_err();
        assert_eq!(blocked.code, "demo_rate_limit");
        assert_eq!(blocked.retry_after_seconds, 1);
        assert_eq!(limits.check_run(next, "one", expiry), Ok(()));
        limits.record_run(next, "one", expiry);
        let blocked = limits.check_run(ip(), "two", expiry).unwrap_err();
        assert_eq!(blocked.code, "demo_rate_limit");
        assert_eq!(blocked.retry_after_seconds, 10);
    }
    #[test]
    fn overlapping_quotas_report_the_later_expiry_and_prefer_the_ip_on_ties() {
        let now = Instant::now();
        for (ip_delay, expected_wait) in [(7, 3597), (0, 3590)] {
            let mut limits = DemoLimits::default();
            let mut questions = vec![(ip_delay, ip()); 10];
            questions.extend((2..=91).map(|n| (0, IpAddr::from([192, 0, 2, n]))));
            questions.sort_unstable();
            for (index, (delay, address)) in questions.into_iter().enumerate() {
                let session = format!("session-{index}");
                let at = now + Duration::from_secs(delay);
                assert_eq!(limits.check_run(address, &session, at), Ok(()));
                limits.record_run(address, &session, at);
            }
            let blocked = limits
                .check_run(ip(), "next", now + Duration::from_secs(10))
                .unwrap_err();
            assert_eq!(blocked.code, "ip_rate_limit");
            assert_eq!(blocked.retry_after_seconds, expected_wait);
        }
    }
    #[test]
    fn same_session_has_a_five_second_cooldown_but_another_visitor_can_start() {
        let mut limits = DemoLimits::default();
        let now = Instant::now();
        limits.record_run(ip(), "one", now);
        let blocked = limits
            .check_run(ip(), "one", now + Duration::from_millis(3500))
            .unwrap_err();
        assert_eq!(blocked.code, "session_cooldown");
        assert_eq!(blocked.retry_after_seconds, 2, "round remaining time up");
        assert_eq!(limits.check_run(ip(), "two", now), Ok(()));
        assert_eq!(
            limits.check_run(ip(), "one", now + Duration::from_secs(5)),
            Ok(())
        );
    }
    #[test]
    fn session_creation_is_limited_independently_of_questions() {
        let mut limits = DemoLimits::default();
        let now = Instant::now();
        for _ in 0..30 {
            assert_eq!(limits.check_session(ip(), now), Ok(()));
            limits.record_session(ip(), now);
        }
        let blocked = limits.check_session(ip(), now).unwrap_err();
        assert_eq!(blocked.code, "session_limit");
        assert_eq!(blocked.retry_after_seconds, 600);
        assert_eq!(limits.check_run(ip(), "one", now), Ok(()));
        assert_eq!(
            limits.check_session(ip(), now + Duration::from_secs(600)),
            Ok(())
        );
    }
    #[test]
    fn only_the_explicit_proxy_can_supply_one_real_ip() {
        let proxy = "127.0.0.1".parse().unwrap();
        assert_eq!(client_ip(ip(), None, Some("203.0.113.9")), Ok(ip()));
        assert_eq!(client_ip(ip(), Some(proxy), Some("203.0.113.9")), Ok(ip()));
        assert_eq!(
            client_ip(proxy, Some(proxy), Some("203.0.113.9")),
            Ok("203.0.113.9".parse().unwrap())
        );
        assert!(client_ip(proxy, Some(proxy), Some("203.0.113.9, 192.0.2.4")).is_err());
        assert!(client_ip(proxy, Some(proxy), None).is_err());
    }
    #[test]
    fn client_identity_groups_ipv6_prefixes_without_merging_other_networks() {
        for (address, expected) in [
            ("2001:db8:1:2::1", "2001:db8:1:2::"),
            ("2001:db8:1:2::beef", "2001:db8:1:2::"),
            ("2001:db8:1:3::1", "2001:db8:1:3::"),
            ("::ffff:192.0.2.1", "192.0.2.1"),
        ] {
            assert_eq!(
                client_ip(address.parse().unwrap(), None, None),
                Ok(expected.parse().unwrap()),
                "client identity for {address}"
            );
        }
    }
    #[test]
    fn full_memory_does_not_evict_existing_quota_and_expires_after_the_window() {
        let now = Instant::now();
        let mut limits = DemoLimits::default();
        for n in 1..MAX_CLIENTS {
            let address = IpAddr::V4(std::net::Ipv4Addr::from(n as u32));
            limits.record_session(address, now);
        }
        let original = IpAddr::V4(std::net::Ipv4Addr::from(0));
        for _ in 0..10 {
            limits.record_run(original, "one", now);
        }
        assert_eq!(
            limits.check_run(ip(), "new", now).unwrap_err().code,
            "rate_limit"
        );
        assert_eq!(
            limits.check_run(original, "new", now).unwrap_err().code,
            "ip_rate_limit"
        );
        assert_eq!(
            limits.check_run(ip(), "new", now + Duration::from_secs(3600)),
            Ok(())
        );
    }
}
