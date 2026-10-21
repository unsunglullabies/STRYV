// Study is a small spaced-repetition layer that lives beside AERY. Decks and
// cards are STRYV data (not vault files), stored as one JSON document next to the
// vault config. Cards may point at a note; the pointer is an id, so renaming or
// moving the note does not break the card.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const STUDY_DB: &str = "study.json";
const DAY: u64 = 86_400;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Deck {
    pub id: String,
    pub name: String,
    pub subject: String,
    pub created: u64,
    pub updated: u64,
}

impl Default for Deck {
    fn default() -> Self {
        Deck { id: String::new(), name: String::new(), subject: String::new(), created: 0, updated: 0 }
    }
}

fn default_ease() -> f64 { 2.5 }

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Card {
    pub id: String,
    pub deck_id: String,
    pub question: String,
    pub answer: String,
    pub source_note_id: String,
    pub created: u64,
    pub updated: u64,
    pub ease: f64,
    pub interval_days: u64,
    pub reps: u64,
    pub lapses: u64,
    pub due: u64,
    pub last_review: u64,
}

impl Default for Card {
    fn default() -> Self {
        Card {
            id: String::new(), deck_id: String::new(), question: String::new(), answer: String::new(),
            source_note_id: String::new(), created: 0, updated: 0,
            ease: default_ease(), interval_days: 0, reps: 0, lapses: 0, due: 0, last_review: 0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Review {
    pub t: u64,
    pub card_id: String,
    pub grade: String,
    pub remembered: bool,
}

impl Default for Review {
    fn default() -> Self { Review { t: 0, card_id: String::new(), grade: String::new(), remembered: false } }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Wrong {
    pub card_id: String,
    pub question: String,
    pub chosen: String,
    pub answer: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct QuizResult {
    pub id: String,
    pub deck_id: String,
    pub title: String,
    pub t: u64,
    pub total: u64,
    pub correct: u64,
    pub wrong: Vec<Wrong>,
}

impl Default for QuizResult {
    fn default() -> Self {
        QuizResult { id: String::new(), deck_id: String::new(), title: String::new(), t: 0, total: 0, correct: 0, wrong: Vec::new() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Session {
    pub id: String,
    pub deck_id: String,
    pub started: u64,
    pub ended: u64,
    pub cards: u64,
    pub remembered: u64,
    pub quiz_total: u64,
    pub quiz_correct: u64,
}

impl Default for Session {
    fn default() -> Self {
        Session { id: String::new(), deck_id: String::new(), started: 0, ended: 0, cards: 0, remembered: 0, quiz_total: 0, quiz_correct: 0 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct StudyStore {
    pub version: u32,
    pub decks: Vec<Deck>,
    pub cards: Vec<Card>,
    pub reviews: Vec<Review>,
    pub quizzes: Vec<QuizResult>,
    pub sessions: Vec<Session>,
}

impl Default for StudyStore {
    fn default() -> Self {
        StudyStore { version: 1, decks: Vec::new(), cards: Vec::new(), reviews: Vec::new(), quizzes: Vec::new(), sessions: Vec::new() }
    }
}

fn now() -> u64 { super::now_unix() }

fn nid(prefix: &str) -> String {
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{}{:x}", prefix, t)
}

fn study_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(STUDY_DB))
}

fn load_at(path: &Path) -> StudyStore {
    let Ok(text) = std::fs::read_to_string(path) else { return StudyStore::default() };
    match serde_json::from_str::<StudyStore>(&text) {
        Ok(mut s) => {
            if s.version == 0 { s.version = 1; }
            s
        }
        Err(_) => {
            // Keep the damaged file instead of overwriting it with an empty
            // store; the user may still be able to rescue their decks by hand.
            let bad = path.with_extension(format!("corrupt-{}", now()));
            let _ = std::fs::rename(path, bad);
            StudyStore::default()
        }
    }
}

fn save_at(path: &Path, s: &StudyStore) -> Result<(), String> {
    let body = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    super::aery::aery_atomic_write(path, body.as_bytes())
}

fn load(app: &tauri::AppHandle) -> Result<StudyStore, String> {
    Ok(load_at(&study_path(app)?))
}

fn save(app: &tauri::AppHandle, s: &StudyStore) -> Result<StudyStore, String> {
    save_at(&study_path(app)?, s)?;
    Ok(s.clone())
}

fn clean_id(prefix: &str, id: &str) -> String {
    let t = id.trim();
    if t.is_empty() { nid(prefix) } else { t.to_string() }
}

/// SM-2-lite. Deterministic: the same card, grade and clock always produce the
/// same schedule, which is what the tests pin down.
fn schedule(card: &mut Card, grade: &str, at: u64) {
    let g = grade.to_lowercase();
    let prev_reps = card.reps;
    let prev_interval = card.interval_days;
    let interval;
    match g.as_str() {
        "again" => {
            card.lapses += 1;
            card.ease = (card.ease - 0.2).max(1.3);
            card.reps = 0;
            interval = 0;
        }
        "hard" => {
            card.ease = (card.ease - 0.15).max(1.3);
            interval = if prev_interval == 0 { 1 } else { ((prev_interval as f64) * 1.2).round() as u64 };
            card.reps = prev_reps + 1;
        }
        "easy" => {
            card.ease = (card.ease + 0.15).min(3.0);
            interval = if prev_reps == 0 { 3 } else { ((prev_interval as f64) * card.ease * 1.3).round().max(1.0) as u64 };
            card.reps = prev_reps + 1;
        }
        _ => {
            interval = if prev_reps == 0 { 1 } else if prev_reps == 1 { 3 } else { ((prev_interval as f64) * card.ease).round().max(1.0) as u64 };
            card.reps = prev_reps + 1;
        }
    }
    card.interval_days = interval;
    card.due = at + interval * DAY;
    card.last_review = at;
    card.updated = at;
}

#[tauri::command]
pub fn study_load(app: tauri::AppHandle) -> Result<StudyStore, String> { load(&app) }

#[tauri::command]
pub fn study_deck_save(app: tauri::AppHandle, deck: Deck) -> Result<StudyStore, String> {
    let mut s = load(&app)?;
    let name = deck.name.trim().to_string();
    if name.is_empty() { return Err("A deck needs a name.".into()); }
    let at = now();
    if deck.id.trim().is_empty() {
        s.decks.push(Deck { id: nid("d"), name, subject: deck.subject.trim().to_string(), created: at, updated: at });
    } else {
        let Some(d) = s.decks.iter_mut().find(|d| d.id == deck.id) else {
            return Err("That deck is gone.".into());
        };
        d.name = name;
        d.subject = deck.subject.trim().to_string();
        d.updated = at;
    }
    save(&app, &s)
}

#[tauri::command]
pub fn study_deck_delete(app: tauri::AppHandle, id: String, delete_cards: bool) -> Result<StudyStore, String> {
    let mut s = load(&app)?;
    s.decks.retain(|d| d.id != id);
    if delete_cards {
        s.cards.retain(|c| c.deck_id != id);
    }
    save(&app, &s)
}

#[tauri::command]
pub fn study_card_save(app: tauri::AppHandle, card: Card) -> Result<StudyStore, String> {
    let mut s = load(&app)?;
    let question = card.question.trim().to_string();
    let answer = card.answer.trim().to_string();
    if question.is_empty() || answer.is_empty() {
        return Err("A card needs a question and an answer.".into());
    }
    if !s.decks.iter().any(|d| d.id == card.deck_id) {
        return Err("Choose a deck for this card.".into());
    }
    let at = now();
    if card.id.trim().is_empty() {
        s.cards.push(Card {
            id: nid("c"), deck_id: card.deck_id, question, answer,
            source_note_id: card.source_note_id.trim().to_string(),
            created: at, updated: at, ease: default_ease(),
            interval_days: 0, reps: 0, lapses: 0, due: at, last_review: 0,
        });
    } else {
        let Some(c) = s.cards.iter_mut().find(|c| c.id == card.id) else {
            return Err("That card is gone.".into());
        };
        c.deck_id = card.deck_id;
        c.question = question;
        c.answer = answer;
        c.source_note_id = card.source_note_id.trim().to_string();
        c.updated = at;
    }
    save(&app, &s)
}

#[tauri::command]
pub fn study_card_delete(app: tauri::AppHandle, id: String) -> Result<StudyStore, String> {
    let mut s = load(&app)?;
    s.cards.retain(|c| c.id != id);
    save(&app, &s)
}

#[tauri::command]
pub fn study_review(app: tauri::AppHandle, id: String, grade: String, session: Option<String>) -> Result<StudyStore, String> {
    let mut s = load(&app)?;
    let at = now();
    let remembered = grade.to_lowercase() != "again";
    {
        let Some(card) = s.cards.iter_mut().find(|c| c.id == id) else {
            return Err("That card is gone.".into());
        };
        schedule(card, &grade, at);
    }
    s.reviews.push(Review { t: at, card_id: id.clone(), grade, remembered });
    if let Some(sid) = session {
        if let Some(sess) = s.sessions.iter_mut().find(|x| x.id == sid) {
            sess.cards += 1;
            if remembered { sess.remembered += 1; }
            sess.ended = at;
        }
    }
    save(&app, &s)
}

#[tauri::command]
pub fn study_quiz_save(app: tauri::AppHandle, quiz: QuizResult) -> Result<StudyStore, String> {
    let mut s = load(&app)?;
    let at = now();
    let mut q = quiz;
    q.id = clean_id("q", &q.id);
    q.t = at;
    // Scores are clamped to the question count so a malformed caller cannot
    // report 12/10 in the progress view.
    q.correct = q.correct.min(q.total);
    if let Some(sess) = s.sessions.iter_mut().rev().find(|x| x.ended == 0) {
        sess.quiz_total = q.total;
        sess.quiz_correct = q.correct;
        sess.ended = at;
    }
    s.quizzes.push(q);
    save(&app, &s)
}

#[tauri::command]
pub fn study_session_start(app: tauri::AppHandle, deck: Option<String>) -> Result<StudyStore, String> {
    let mut s = load(&app)?;
    // Only one open session at a time; leaving older ones open would make the
    // dashboard's "in progress" state ambiguous.
    for x in s.sessions.iter_mut().filter(|x| x.ended == 0) {
        x.ended = now();
    }
    s.sessions.push(Session {
        id: nid("s"), deck_id: deck.unwrap_or_default(), started: now(), ..Default::default()
    });
    save(&app, &s)
}

#[tauri::command]
pub fn study_session_end(app: tauri::AppHandle, id: String) -> Result<StudyStore, String> {
    let mut s = load(&app)?;
    if let Some(x) = s.sessions.iter_mut().find(|x| x.id == id) {
        x.ended = now();
    }
    save(&app, &s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card() -> Card {
        Card { id: "c1".into(), deck_id: "d1".into(), question: "q".into(), answer: "a".into(), due: 0, ..Default::default() }
    }

    fn at(n: u64) -> u64 { 1_700_000_000 + n }

    #[test]
    fn the_first_good_review_schedules_tomorrow() {
        let mut c = card();
        schedule(&mut c, "good", at(0));
        assert_eq!(c.interval_days, 1);
        assert_eq!(c.reps, 1);
        assert_eq!(c.due, at(0) + DAY);
        assert_eq!(c.ease, 2.5);
    }

    #[test]
    fn the_second_good_review_uses_the_three_day_step() {
        let mut c = card();
        schedule(&mut c, "good", at(0));
        schedule(&mut c, "good", at(1));
        assert_eq!(c.interval_days, 3);
        assert_eq!(c.reps, 2);
    }

    #[test]
    fn later_good_reviews_multiply_by_ease() {
        let mut c = card();
        schedule(&mut c, "good", at(0));
        schedule(&mut c, "good", at(1));
        let before = c.ease;
        schedule(&mut c, "good", at(2));
        assert_eq!(c.interval_days, (3.0 * before).round() as u64);
    }

    #[test]
    fn again_resets_the_streak_and_lowers_ease() {
        let mut c = card();
        schedule(&mut c, "good", at(0));
        schedule(&mut c, "good", at(1));
        schedule(&mut c, "again", at(2));
        assert_eq!(c.interval_days, 0);
        assert_eq!(c.reps, 0);
        assert_eq!(c.lapses, 1);
        assert!(c.ease < 2.5);
        assert_eq!(c.due, at(2));
    }

    #[test]
    fn ease_never_falls_below_the_floor() {
        let mut c = card();
        for i in 0..20 { schedule(&mut c, "again", at(i)); }
        assert_eq!(c.ease, 1.3);
    }

    #[test]
    fn hard_grows_slower_than_good_and_easy_faster() {
        let mut hard = card();
        let mut good = card();
        let mut easy = card();
        for i in 0..4 {
            schedule(&mut hard, "hard", at(i));
            schedule(&mut good, "good", at(i));
            schedule(&mut easy, "easy", at(i));
        }
        assert!(hard.interval_days < good.interval_days, "hard {} vs good {}", hard.interval_days, good.interval_days);
        assert!(easy.interval_days > good.interval_days, "easy {} vs good {}", easy.interval_days, good.interval_days);
    }

    #[test]
    fn a_missing_store_is_empty_and_a_corrupt_one_is_preserved() {
        let dir = std::env::temp_dir().join(format!("stryv-study-{}", nid("t")));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("study.json");
        assert_eq!(load_at(&p).decks.len(), 0);
        std::fs::write(&p, "{ not json").unwrap();
        let s = load_at(&p);
        assert_eq!(s.decks.len(), 0);
        assert!(!p.exists(), "the corrupt file should have been moved aside");
        let kept = std::fs::read_dir(&dir).unwrap().flatten().count();
        assert_eq!(kept, 1, "exactly one preserved corrupt file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_store_round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("stryv-study-{}", nid("t")));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("study.json");
        let mut s = StudyStore::default();
        s.decks.push(Deck { id: "d1".into(), name: "Biology".into(), ..Default::default() });
        s.cards.push(card());
        save_at(&p, &s).unwrap();
        let back = load_at(&p);
        assert_eq!(back.decks[0].name, "Biology");
        assert_eq!(back.cards[0].question, "q");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
