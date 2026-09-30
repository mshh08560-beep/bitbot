export interface ChatSource {
  title: string;
  uri: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  imageUrl?: string;
  isImage?: boolean;
  isError?: boolean;
  originalPrompt?: string;
  sources?: ChatSource[];
}

export interface UserSubscription {
  isPro: boolean;
  proActivatedAt?: number;
  freeImagesUsed: number;
  maxFreeImages: number;
}
