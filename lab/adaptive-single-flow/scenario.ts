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
  readonly assist: boolean;
  readonly vocab?: string;
  readonly intent?: string;
  readonly translation?: string;
  readonly translationAt?: number;
}

export const JOIN_AT = 120;
export const END_AT = 480;

export const utterances: readonly Utterance[] = [
  {
    at: 20,
    id: "opening-1",
    speaker: "amara",
    text: "Nightly analytics exports are slow and search results look stale.",
    assist: false,
  },
  {
    at: 70,
    id: "opening-2",
    speaker: "theo",
    text: "Export pages keep timing out after the reporting batch.",
    assist: false,
  },
  {
    at: 120,
    id: "join",
    speaker: "jonas",
    text: "Sorry, just joined. Is the export delayed or is the index stale?",
    assist: false,
  },
  {
    at: 150,
    id: "cursor",
    speaker: "jonas",
    text: "The export cursor marks our position. We can resume from the last stored cursor.",
    assist: true,
    vocab: "cursor = penanda posisi halaman ekspor; resume = lanjut dari posisi tersimpan",
    intent: "Jonas proposes resuming from the saved position instead of restarting.",
    translation:
      "Kursor ekspor menandai posisi kita. Kita bisa lanjut dari kursor terakhir yang tersimpan.",
  },
  {
    at: 190,
    id: "throttle",
    speaker: "priya",
    text: "The API is throttling us. We back off with jitter before retrying.",
    assist: true,
    vocab: "throttle = API membatasi laju; backoff with jitter = tunggu acak sebelum mencoba lagi",
    intent: "Priya explains the delay is rate-limiting, not missing data.",
    translation: "API membatasi laju kita. Kita menunggu acak sebelum mencoba lagi.",
    translationAt: 215,
  },
  {
    at: 250,
    id: "window-question",
    speaker: "amara",
    text: "Jonas or Priya, can we run the rebuild tonight?",
    assist: false,
  },
  {
    at: 270,
    id: "window-clarify",
    speaker: "amara",
    text: "Priya, please confirm the disk and the throttle first.",
    assist: false,
  },
  {
    at: 300,
    id: "go-question",
    speaker: "amara",
    text: "Priya, what do you recommend if the disk and the throttle look fine?",
    assist: false,
  },
  {
    at: 330,
    id: "watermark",
    speaker: "priya",
    text: "Disk watermark reached. Hold the rebuild. The earlier ready note is no longer valid.",
    assist: true,
    vocab: "watermark = batas aman kapasitas disk; hold = tunda tanpa membatalkan",
    intent: "Priya blocks the rebuild; earlier readiness no longer applies.",
    translation: "Batas disk tercapai. Tunda rebuild. Catatan siap sebelumnya sudah tidak berlaku.",
  },
  {
    at: 380,
    id: "cursor-probe",
    speaker: "amara",
    text: "Jonas, how is the cursor probe?",
    assist: false,
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
    at: 250,
    text: "Jonas or Priya, can we run the rebuild tonight?",
    meaning: "Amara menanyakan apakah rebuild boleh jalan malam ini.",
    addressee: "Belum jelas: Jonas atau Priya.",
    evidence: ["window-question"],
  },
  {
    id: "go-question",
    at: 300,
    text: "Priya, what do you recommend if the disk and the throttle look fine?",
    meaning: "Amara meminta rekomendasi Priya bila disk dan throttle aman.",
    addressee: "Amara meminta Priya.",
    evidence: ["go-question", "window-clarify"],
  },
  {
    id: "cursor-probe",
    at: 380,
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
    suggestAt: 250,
    draftEn: "Is that for me? I can report the cursor and throttle evidence.",
    draftId: "Itu untuk saya? Saya bisa melaporkan bukti kursor dan throttle.",
    holdingEn: "Was that for me or Jonas? I can report what I know.",
    holdingId: "Itu untuk saya atau Jonas? Saya bisa melaporkan yang saya tahu.",
  },
  {
    questionId: "go-question",
    suggestAt: 312,
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
    at: 270,
    affects: ["window-question"],
    invalidates: false,
    text: "Amara asks Priya to confirm the disk and the throttle first.",
  },
  {
    id: "watermark",
    at: 330,
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
    at: 150,
    from: 20,
    through: 120,
    text: "Exports are slow and the index looks stale. Jonas asked which part is stale.",
    evidence: ["opening-1", "opening-2", "join"],
  },
  {
    at: 380,
    from: 300,
    through: 330,
    text: "Amara asked for a conditional recommendation, then Priya blocked the rebuild at the disk watermark.",
    evidence: ["go-question", "watermark"],
  },
];

export const coverage: readonly { readonly at: number; readonly text: string }[] = [
  { at: 345, text: "Capture gap: about 15 s of audio is missing." },
  {
    at: 360,
    text: "Connection resumed. Speech during the gap is outside coverage.",
  },
];

export const closing = {
  review:
    "Hold the rebuild. Priya owns the disk and throttle checks. Jonas owns the cursor probe. Amara decides the window.",
  learn: "What does backoff with jitter mean here? Try before opening ANSWER.",
  answer: "Wait a random short interval before retrying so retries do not pile up.",
};
