/** Only metadata travels with the character; model files live in this device's IndexedDB. */
export interface CharacterLive2D {
  assetId: string;
  name: string;
  bytes: number;
  fileCount: number;
  expressions: string[];
  motions: string[];
  /** App expression → exported .exp3 name. Empty means the model's neutral face. */
  expressionMap: Record<string, string>;
  /** App expression / greeting / agree / disagree → group:index. */
  motionMap: Record<string, string>;
}
