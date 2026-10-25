// The only model the native OpenAI /decisions endpoint is validated against.
export const nativeDecisionModel = "gpt-6-luna";
export type TypedDecisionValue = string | boolean;
export type TypedDecisionQuestion = { type: "choice"; name: string; instructions: string; optional?: boolean | undefined;
  choices: readonly { value: TypedDecisionValue; description?: string | undefined }[] } |
  { type: "predicate"; name: string; instructions: string; optional?: boolean | undefined };
export interface TypedDecisionAnswer { value: TypedDecisionValue | number; confidence: number }
