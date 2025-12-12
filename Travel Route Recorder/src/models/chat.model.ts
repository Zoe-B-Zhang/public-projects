export interface Message {
  author: 'user' | 'ai';
  content: string;
  groundingChunks?: { web: { uri: string; title: string } }[];
}

export type AppState = 'initial' | 'clarifying_sequence' | 'route_generated' | 'editing_style' | 'generating_stamps' | 'generating_video';
