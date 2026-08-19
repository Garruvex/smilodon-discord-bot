import Uwuifier from "uwuifier";

const uwuifier = new Uwuifier();

export function owoify(input: string): string {
  return uwuifier.uwuifySentence(input);
}
