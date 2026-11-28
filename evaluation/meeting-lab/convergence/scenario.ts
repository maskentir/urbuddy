import type { MeetingEvent } from "../model.js";
import { events as baseline } from "../scenario.js";

export interface Copy {
  readonly id: string;
  readonly en: string;
}

const copy = (id: string, en: string): Copy => ({ id, en });

export const answers = [
  {
    id: "question",
    at: 605,
    question: copy(
      "Apakah flag aman dinyalakan hari ini?",
      "Can we turn the flag on safely today?",
    ),
    addressed: copy("Belum jelas: Leo atau Sari.", "Addressee unclear: Leo or Sari."),
    response: copy(
      "Apakah pertanyaan itu untuk saya? Saya bisa menjelaskan bukti dari staging.",
      "Did you want me to answer? I can speak to the staging evidence.",
    ),
    evidence: ["question", "question-overlap"],
  },
  {
    id: "clarification",
    at: 624,
    question: copy(
      "Sari, boleh nyalakan flag sebelum uji dua worker?",
      "Sari, can we enable it before the two-worker test?",
    ),
    addressed: copy("Rina menyebut Sari.", "Rina names Sari."),
    response: copy(
      "Saya akan menunggu. Uji satu worker lulus, tetapi retry bersamaan belum diverifikasi.",
      "I'd wait. The single-worker test passed, but we haven't verified concurrent retries.",
    ),
    evidence: ["clarification", "unrun"],
  },
  {
    id: "go-question",
    at: 644,
    question: copy(
      "Sari, rekomendasi untuk deployment jika migrasi dan uji lulus?",
      "Sari, what do you recommend if migration and the test pass?",
    ),
    addressed: copy("Rina meminta rekomendasi Sari.", "Rina asks Sari for a recommendation."),
    response: copy(
      "Lanjutkan hanya untuk pilot jika migrasi berhasil dan uji retry dua worker lulus. Jika salah satu hasil belum ada, tahan deployment. Biarkan flag mati dan sebutkan hasil yang masih ditunggu.",
      "Proceed with the pilot only if the migration succeeds and the two-worker retry test passes. If either result is missing, hold the deployment. Leave the flag off and say which result is still pending.",
    ),
    evidence: ["go-question", "unrun", "rollback"],
  },
  {
    id: "leo-question",
    at: 674,
    question: copy("Leo, bagaimana status rollback?", "Leo, what is the rollback status?"),
    addressed: copy("Pertanyaan untuk Leo.", "Question addressed to Leo."),
    response: undefined,
    evidence: ["leo-question"],
  },
] as const;

export const changes = [
  {
    id: "clarification",
    at: 624,
    affects: ["question"],
    text: copy(
      "Rina mengklarifikasi bahwa pertanyaan ditujukan ke Sari.",
      "Rina clarifies that the question is for Sari.",
    ),
  },
  {
    id: "go-question",
    at: 644,
    affects: ["question", "clarification"],
    text: copy(
      "Rina meminta rekomendasi dengan syarat baru.",
      "Rina asks for a recommendation under a new condition.",
    ),
  },
  {
    id: "migration-failed",
    at: 660,
    affects: ["question", "clarification", "go-question"],
    text: copy("Migrasi gagal. Jangan deploy.", "The migration failed. Do not deploy."),
  },
  {
    id: "leo-question",
    at: 674,
    affects: ["go-question"],
    text: copy(
      "Pertanyaan rollback berikutnya ditujukan ke Leo.",
      "The follow-up rollback question is addressed to Leo.",
    ),
  },
] as const;

export const recaps = [
  {
    at: 180,
    from: 22,
    through: 151,
    evidence: ["opening-1", "opening-2", "opening-3"],
    text: copy(
      "Catatan moderator: checkout timeout setelah charge awal. Demo partner terpisah dan rencana Jumat belum menjadi keputusan yang dapat diverifikasi dari transkrip Anda.",
      "Moderator note: checkout timed out after a charge. The partner demo is separate and Friday cannot be verified from your transcript.",
    ),
  },
  {
    at: 445,
    from: 260,
    through: 430,
    evidence: ["idempotency", "migration-correction"],
    text: copy(
      "Migrasi baru berjalan di staging. Retry dengan key sama tidak boleh menagih lagi.",
      "Migration ran in staging only. Retry with the same key must not charge again.",
    ),
  },
  {
    at: 660,
    from: 644,
    through: 660,
    evidence: ["go-question", "migration-failed"],
    text: copy(
      "Rina meminta rekomendasi bersyarat, lalu membatalkan deployment setelah migrasi gagal.",
      "Rina asked for a conditional recommendation, then blocked deployment after migration failed.",
    ),
  },
  {
    at: 842,
    from: 786,
    through: 795,
    evidence: ["burst-2", "burst-3"],
    text: copy(
      "Rilis hanya untuk peserta pilot. Retry yang sudah antre dapat tetap berjalan setelah flag dimatikan.",
      "Pilot only. Already queued retries may outlive switching off the flag.",
    ),
  },
  {
    at: 1156,
    from: 1048,
    through: 1156,
    evidence: ["pr", "pr-unresolved"],
    text: copy(
      "PR 483 hanya disebut. Diff, layar, dan catatan rapat sebelumnya tidak tersedia.",
      "PR 483 was mentioned. Its diff, the screen and the prior meeting note are unavailable.",
    ),
  },
  {
    at: 1293,
    from: 1270,
    through: 1293,
    evidence: ["reconnected-speaker", "gap-not-known"],
    text: copy(
      "Koneksi pulih. Ucapan saat putus tidak tercakup dan label pembicara mungkin berubah.",
      "Connection resumed. Speech during the gap is outside coverage and speaker labels may have changed.",
    ),
  },
  {
    at: 1530,
    from: 1442,
    through: 1530,
    evidence: ["decision", "owner", "deadline-repeat"],
    text: copy(
      "Senin 10.00 WIB, khusus pilot jika uji dua worker lulus. Sari memutuskan go/no-go. Pesan Mira paling lambat Senin siang setelah keputusan go.",
      "Monday 10:00 WIB, pilot only if the two-worker test passes. Sari owns go/no-go. Mira's message is due by Monday noon after go.",
    ),
  },
];

export const closing = {
  review: copy(
    "Pilot Senin 10.00 WIB jika uji lulus. Sari memutuskan go/no-go. Dimas menyiapkan hasil dan rollback pukul 09.00 WIB. Mira mengirim pesan paling lambat pukul 12.00 WIB setelah go. Leo memantau charge ganda. PR, layar dan celah rekaman tetap belum terverifikasi.",
    "Pilot Monday 10:00 WIB if the test passes. Sari owns go/no-go. Dimas provides test and rollback evidence by 09:00. Mira sends the note by noon after go. Leo monitors duplicate charges. PR, screen and capture gaps remain unverified.",
  ),
  learn: copy(
    "Apa arti idempotent untuk checkout setelah timeout? Coba jawab sebelum membuka JAWABAN.",
    "What does idempotent mean for a checkout retry after timeout? Try before opening ANSWER.",
  ),
  answer: copy(
    "Key yang sama harus menghasilkan efek yang sama, tanpa charge kedua.",
    "The same key must produce the same effect, with no second charge.",
  ),
};

const added: readonly MeetingEvent[] = [
  {
    at: 334,
    kind: "translation",
    sourceId: "race",
    revision: 0,
    text: "Dua worker dapat membaca key yang belum ada sebelum salah satunya menulis. Keduanya bisa menagih.",
  },
  {
    at: 644,
    kind: "utterance",
    id: "go-question",
    speaker: "rina",
    language: "en",
    final: true,
    revision: 0,
    text: "Sari, what do you recommend if migration and the test pass?",
  },
  {
    at: 660,
    kind: "utterance",
    id: "migration-failed",
    speaker: "dimas",
    language: "en",
    final: true,
    revision: 0,
    text: "The migration failed. Do not deploy. What we said about being ready is no longer valid. The staging retry test is still required before we revisit the pilot.",
    supersedes: ["assertion"],
  },
  {
    at: 662,
    kind: "translation",
    sourceId: "migration-failed",
    revision: 0,
    text: "Migrasi gagal. Jangan deploy. Pernyataan bahwa kita siap sudah tidak berlaku. Uji retry di staging masih diperlukan sebelum kita membahas kembali pilot.",
  },
  {
    at: 674,
    kind: "utterance",
    id: "leo-question",
    speaker: "rina",
    language: "en",
    final: true,
    revision: 0,
    text: "Leo, what is the rollback status?",
  },
  {
    at: 675,
    kind: "utterance",
    id: "unicode-check",
    speaker: "leo",
    language: "mixed",
    final: true,
    revision: 0,
    text: "Flag mati. Cek ロールバック dan catatan café. Marker 👩🏽‍💻 ada di log sintetis.",
  },
];

export const events = [...baseline, ...added].toSorted((a, b) => a.at - b.at);
export const requested = new Set([
  "race",
  "idempotency",
  "migration-correction",
  "burst-3",
  "request-link",
  "sre-label",
  "migration-failed",
]);
