export const EXIT_CODES = {
  success: 0,
  generalError: 1,
  usage: 2,
  configError: 3,
  cancelled: 130,
} as const;

export type ExitCodeName = keyof typeof EXIT_CODES;
export type ExitCode = (typeof EXIT_CODES)[ExitCodeName];
