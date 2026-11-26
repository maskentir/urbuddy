export interface CliOutput {
  out(line: string): void;
  errLine(line: string): void;
}
