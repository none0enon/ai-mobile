export interface Live2DParameter {
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
}

export interface Live2DOutfit {
  id: string;
  name: string;
  /** Comma/newline separated names or tags from the character's rhythm wardrobe. */
  match: string;
  /** Absolute model parameter values, independent of facial expressions. */
  parameters: Record<string, number>;
}

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
  /** Optional for models uploaded before outfit support. Discovered on next load. */
  parameters?: Live2DParameter[];
  outfits?: Live2DOutfit[];
  defaultOutfit?: string;
  /** Multiplier on the automatic silhouette fit. Aspect ratio and bottom anchor stay fixed. */
  framing?: { zoom: number };
}
