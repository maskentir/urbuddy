export interface Participant {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

export const participants: readonly Participant[] = [
  { id: "amara", name: "Amara", role: "PM" },
  { id: "jonas", name: "Jonas", role: "backend engineer" },
  { id: "priya", name: "Priya", role: "SRE" },
  { id: "theo", name: "Theo", role: "frontend engineer" },
];

export interface Utterance {
  readonly at: number;
  readonly id: string;
  readonly speaker: string;
  readonly text: string;
  readonly vocab?: string;
  readonly intent?: string;
  readonly translation?: string;
  readonly translationAt?: number;
}

export const END_AT = 208;

export const utterances: readonly Utterance[] = [
  {
    at: 5,
    id: "opening-1",
    speaker: "amara",
    text: "Nightly analytics exports are slow and search results look stale.",
  },
  {
    at: 18,
    id: "opening-2",
    speaker: "theo",
    text: "Export pages keep timing out after the reporting batch.",
  },
  {
    at: 30,
    id: "join",
    speaker: "jonas",
    text: "Sorry, just joined. Is the export delayed or is the index stale?",
  },
  {
    at: 42,
    id: "cursor",
    speaker: "jonas",
    text: "The export cursor marks our position. We can resume from the last stored cursor.",
    vocab: "cursor = penanda posisi halaman ekspor; resume = lanjut dari posisi tersimpan",
    intent: "Jonas proposes resuming from the saved position instead of restarting.",
    translation:
      "Kursor ekspor menandai posisi kita. Kita bisa lanjut dari kursor terakhir yang tersimpan.",
  },
  {
    at: 58,
    id: "throttle",
    speaker: "priya",
    text: "The API is throttling us. We back off with jitter before retrying.",
    vocab: "throttle = API membatasi laju; backoff with jitter = tunggu acak sebelum mencoba lagi",
    intent: "Priya explains the delay is rate-limiting, not missing data.",
    translation: "API membatasi laju kita. Kita menunggu acak sebelum mencoba lagi.",
    translationAt: 72,
  },
  {
    at: 78,
    id: "cursor-fix",
    speaker: "jonas",
    text: "The cursor is at offset nine. No, the cursor expired, run a fresh probe.",
    vocab: "offset = posisi; probe = uji cepat",
    intent: "Jonas corrects himself; the first reading was wrong.",
    translation: "Kursor di offset sembilan. Bukan, kursor kedaluwarsa, jalankan probe baru.",
  },
  {
    at: 95,
    id: "window-question",
    speaker: "amara",
    text: "Jonas or Priya, can we run the rebuild tonight?",
  },
  {
    at: 108,
    id: "window-clarify",
    speaker: "amara",
    text: "Priya, please confirm the disk and the throttle first.",
  },
  {
    at: 120,
    id: "go-question",
    speaker: "amara",
    text: "Priya, what do you recommend if the disk and the throttle look fine?",
  },
  {
    at: 145,
    id: "watermark",
    speaker: "priya",
    text: "Disk watermark reached. Hold the rebuild. The earlier ready note is no longer valid.",
    vocab: "watermark = batas aman kapasitas disk; hold = tunda tanpa membatalkan",
    intent: "Priya blocks the rebuild; earlier readiness no longer applies.",
    translation: "Batas disk tercapai. Tunda rebuild. Catatan siap sebelumnya sudah tidak berlaku.",
  },
  {
    at: 182,
    id: "cursor-probe",
    speaker: "amara",
    text: "Jonas, how is the cursor probe?",
  },
  {
    at: 196,
    id: "closing-line",
    speaker: "amara",
    text: "Let us stop here. Priya owns the disk check, Jonas owns the probe.",
  },
];

export interface Question {
  readonly id: string;
  readonly at: number;
  readonly text: string;
  readonly meaning: string;
  readonly addressee: string;
  readonly evidence: readonly string[];
}

export const questions: readonly Question[] = [
  {
    id: "window-question",
    at: 95,
    text: "Jonas or Priya, can we run the rebuild tonight?",
    meaning: "Amara menanyakan apakah rebuild boleh jalan malam ini.",
    addressee: "Belum jelas: Jonas atau Priya.",
    evidence: ["window-question"],
  },
  {
    id: "go-question",
    at: 120,
    text: "Priya, what do you recommend if the disk and the throttle look fine?",
    meaning: "Amara meminta rekomendasi Priya bila disk dan throttle aman.",
    addressee: "Amara meminta Priya.",
    evidence: ["go-question", "window-clarify"],
  },
  {
    id: "cursor-probe",
    at: 182,
    text: "Jonas, how is the cursor probe?",
    meaning: "Amara menanyakan status uji probe kursor ke Jonas.",
    addressee: "Amara meminta Jonas.",
    evidence: ["cursor-probe"],
  },
];

export interface Suggestion {
  readonly questionId: string;
  readonly suggestAt: number;
  readonly draftEn: string;
  readonly draftId: string;
  readonly holdingEn: string;
  readonly holdingId: string;
}

export const suggestions: readonly Suggestion[] = [
  {
    questionId: "window-question",
    suggestAt: 95,
    draftEn: "Is that for me? I can report the cursor and throttle evidence.",
    draftId: "Itu untuk saya? Saya bisa melaporkan bukti kursor dan throttle.",
    holdingEn: "Was that for me or Jonas? I can report what I know.",
    holdingId: "Itu untuk saya atau Jonas? Saya bisa melaporkan yang saya tahu.",
  },
  {
    questionId: "go-question",
    suggestAt: 132,
    draftEn:
      "Run the rebuild tonight only if the disk watermark is clear and a short throttle probe passes. Otherwise hold and say which check is pending.",
    draftId:
      "Jalankan rebuild malam ini hanya jika batas disk aman dan uji throttle singkat lulus. Jika tidak, tunda dan sebutkan pemeriksaan yang tertunda.",
    holdingEn: "Let me check the disk and throttle first before recommending.",
    holdingId: "Saya cek dulu disk dan throttle sebelum memberi rekomendasi.",
  },
];

export interface Change {
  readonly id: string;
  readonly at: number;
  readonly affects: readonly string[];
  readonly invalidates: boolean;
  readonly text: string;
}

export const changes: readonly Change[] = [
  {
    id: "window-clarify",
    at: 108,
    affects: ["window-question"],
    invalidates: false,
    text: "Amara asks Priya to confirm the disk and the throttle first.",
  },
  {
    id: "watermark",
    at: 145,
    affects: ["window-question", "go-question"],
    invalidates: true,
    text: "Disk watermark reached. Hold the rebuild.",
  },
];

export interface Recap {
  readonly at: number;
  readonly from: number;
  readonly through: number;
  readonly text: string;
  readonly evidence: readonly string[];
}

export const recaps: readonly Recap[] = [
  {
    at: 48,
    from: 5,
    through: 30,
    text: "Exports are slow and the index looks stale. Jonas asked which part is stale.",
    evidence: ["opening-1", "opening-2", "join"],
  },
  {
    at: 182,
    from: 120,
    through: 145,
    text: "Amara asked for a conditional recommendation, then Priya blocked the rebuild at the disk watermark.",
    evidence: ["go-question", "watermark"],
  },
];

export interface CoverageNotice {
  readonly at: number;
  readonly text: string;
  readonly reason: "capture-gap" | "reconnect";
  readonly skipSeq?: number;
}

export const coverage: readonly CoverageNotice[] = [
  {
    at: 158,
    text: "Audio gap: about 12 s of meeting audio is missing (simulated dropout).",
    reason: "capture-gap",
    skipSeq: 6,
  },
  {
    at: 170,
    text: "Connection resumed. Speech during the gap is outside coverage.",
    reason: "reconnect",
  },
];

export const closing = {
  review:
    "Hold the rebuild. Priya owns the disk and throttle checks. Jonas owns the cursor probe. Amara decides the window.",
  learn: "What does backoff with jitter mean here? Try before opening ANSWER.",
  answer: "Wait a random short interval before retrying so retries do not pile up.",
};
