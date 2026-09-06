/** Notes app contracts (a built-in app-package). */

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface NotesResponse {
  notes: Note[];
}

export interface WriteFileRequest {
  path: string;
  content: string;
}
