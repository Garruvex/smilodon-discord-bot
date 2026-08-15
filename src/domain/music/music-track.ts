export interface MusicTrack {
  identifier: string;
  title: string;
  author: string;
  uri: string;
  artworkUrl: string | null;
  durationMs: number;
  isStream: boolean;
  requestedByUserId: string;
}

export interface EnqueueResult {
  firstTrack: MusicTrack;
  addedTrackCount: number;
  startedPlayback: boolean;
}

