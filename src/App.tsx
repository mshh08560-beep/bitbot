import React, { useState, useEffect, useRef } from 'react';
import { ArrowUp, RotateCcw, LogIn, LogOut, Globe, ExternalLink } from 'lucide-react';
import { BitbotLogo } from './components/BitbotLogo';
import { ThinkingIndicator } from './components/ThinkingIndicator';
import { ChatMessage } from './types';
import {
  auth,
  googleProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  FirebaseUser,
  db,
  collection,
  addDoc,
  query,
  orderBy,
  onSnapshot,
  getDocs,
  deleteDoc,
  doc,
  OperationType,
  handleFirestoreError,
} from './firebase';

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [currentUser, setCurrentUser] = useState<FirebaseUser | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Listen to Firebase Auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setIsAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Sync with Firestore when logged in
  useEffect(() => {
    if (!currentUser) return;

    const path = `users/${currentUser.uid}/messages`;
    try {
      const q = query(collection(db, 'users', currentUser.uid, 'messages'), orderBy('timestamp', 'asc'));
      const unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          const loaded: ChatMessage[] = [];
          snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            loaded.push({
              id: docSnap.id,
              role: data.role,
              content: data.content,
              timestamp: data.timestamp || Date.now(),
              imageUrl: data.imageUrl,
              isImage: data.isImage,
              sources: data.sources,
            });
          });
          setMessages(loaded);
        },
        (error) => {
          handleFirestoreError(error, OperationType.GET, path);
        }
      );

      return () => unsubscribe();
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, path);
    }
  }, [currentUser]);

  // Auto-scroll on new message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSignIn = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error: any) {
      if (
        error?.code === 'auth/popup-closed-by-user' ||
        error?.code === 'auth/cancelled-popup-request'
      ) {
        // User closed or canceled the Google sign-in window intentionally
        return;
      }
      console.warn('Google Sign In:', error?.message || error);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setMessages([]);
    } catch (error: any) {
      console.warn('Google Sign Out:', error?.message || error);
    }
  };

  const handleClear = async () => {
    if (currentUser) {
      const path = `users/${currentUser.uid}/messages`;
      try {
        const colRef = collection(db, 'users', currentUser.uid, 'messages');
        const snap = await getDocs(colRef);
        const deletePromises = snap.docs.map((d) => deleteDoc(doc(db, 'users', currentUser.uid, 'messages', d.id)));
        await Promise.all(deletePromises);
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, path);
      }
    }

    setMessages([]);
    try {
      localStorage.removeItem('bitbot_chat_history');
    } catch {
      // ignore
    }
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const saveMessageToFirestore = async (msg: ChatMessage) => {
    if (!currentUser) return;
    const path = `users/${currentUser.uid}/messages`;
    try {
      await addDoc(collection(db, 'users', currentUser.uid, 'messages'), {
        userId: currentUser.uid,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        imageUrl: msg.imageUrl || null,
        isImage: Boolean(msg.isImage),
        sources: msg.sources || null,
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  };

  const handleSend = async () => {
    const text = inputValue.trim();
    if (!text || isLoading) return;

    setInputValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    const newUserMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    if (!currentUser) {
      setMessages((prev) => [...prev, newUserMsg]);
    } else {
      await saveMessageToFirestore(newUserMsg);
    }

    setIsLoading(true);

    // Image intent check
    const isImageReq =
      /^(\/image|\/img|צור תמונה|תייצר תמונה|צייר לי|תצייר לי|צייר|תמונה של|draw|generate image)[:\s]*/i.test(
        text
      );

    try {
      if (isImageReq) {
        const cleanPrompt = text
          .replace(
            /^(\/image|\/img|צור תמונה|תייצר תמונה|צייר לי|תצייר לי|צייר|תמונה של|draw|generate image)[:\s]*/i,
            ''
          )
          .trim() || text;

        const res = await fetch('/api/generate-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: cleanPrompt }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה ביצירת תמונה');

        const botImgMsg: ChatMessage = {
          id: `bot-img-${Date.now()}`,
          role: 'assistant',
          content: data.commentary || 'הנה התמונה:',
          imageUrl: data.imageUrl,
          isImage: true,
          timestamp: Date.now(),
        };

        if (!currentUser) {
          setMessages((prev) => [...prev, botImgMsg]);
        } else {
          await saveMessageToFirestore(botImgMsg);
        }
      } else {
        const historyPayload = messages.slice(-6).map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, history: historyPayload }),
        });

        const data = await res.json().catch(() => null);

        if (!res.ok) {
          throw new Error(
            data?.error || 'ביטבוט קצת עמוס כרגע, נסה לשאול שוב בעוד רגע.'
          );
        }

        const botMsg: ChatMessage = {
          id: `bot-${Date.now()}`,
          role: 'assistant',
          content: data?.reply || 'אין לי מה להגיד על זה.',
          timestamp: Date.now(),
          sources: data?.sources || undefined,
        };

        if (!currentUser) {
          setMessages((prev) => [...prev, botMsg]);
        } else {
          await saveMessageToFirestore(botMsg);
        }
      }
    } catch (err: any) {
      const errMsg: ChatMessage = {
        id: `bot-err-${Date.now()}`,
        role: 'assistant',
        content: err?.message || 'משהו השתבש, נסה לשאול שוב בעוד רגע.',
        timestamp: Date.now(),
        isError: true,
      };
      if (!currentUser) {
        setMessages((prev) => [...prev, errMsg]);
      } else {
        await saveMessageToFirestore(errMsg);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
  };

  return (
    <div className="flex flex-col h-[100dvh] min-h-[100dvh] bg-white text-zinc-900 font-['Heebo',sans-serif]">
      {/* Header: Minimal & Clean */}
      <header className="w-full px-5 py-3.5 flex items-center justify-between border-b border-zinc-100 bg-white/80 backdrop-blur-xs sticky top-0 z-10 shrink-0">
        <BitbotLogo size="sm" showSubtitle={false} />

        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-500 hover:text-black rounded-lg hover:bg-zinc-100 transition-colors cursor-pointer"
              title="שיחה חדשה"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>שיחה חדשה</span>
            </button>
          )}

          {!isAuthLoading && (
            currentUser ? (
              <div className="flex items-center gap-2">
                {currentUser.photoURL ? (
                  <img
                    src={currentUser.photoURL}
                    alt={currentUser.displayName || 'User'}
                    className="w-7 h-7 rounded-full border border-zinc-200"
                  />
                ) : (
                  <span className="w-7 h-7 rounded-full bg-zinc-900 text-white flex items-center justify-center text-xs font-semibold">
                    {currentUser.displayName?.[0] || 'U'}
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="p-1.5 text-zinc-400 hover:text-zinc-700 rounded-lg hover:bg-zinc-100 transition-colors cursor-pointer"
                  title="התנתק"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleSignIn}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:text-black bg-zinc-50 hover:bg-zinc-100 border border-zinc-200 rounded-lg transition-colors cursor-pointer"
                title="התחבר עם חשבון Google"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>התחבר</span>
              </button>
            )
          )}
        </div>
      </header>

      {/* Main Area: Completely clean empty screen or messages */}
      <main className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 max-w-2xl w-full mx-auto flex flex-col">
        {messages.length === 0 ? (
          <div className="flex-1" />
        ) : (
          <div className="space-y-4 flex-1">
            {messages.map((msg) => {
              const isUser = msg.role === 'user';
              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-[85%] sm:max-w-[75%] px-4 py-3 rounded-2xl text-[15px] leading-relaxed break-words ${
                      isUser
                        ? 'bg-black text-white rounded-br-xs'
                        : msg.isError
                          ? 'bg-rose-50 text-rose-800 border border-rose-200 rounded-bl-xs'
                          : 'bg-zinc-100 text-zinc-900 rounded-bl-xs'
                    }`}
                  >
                    {msg.isImage && msg.imageUrl ? (
                      <div className="space-y-2">
                        {msg.content && (
                          <p className="text-xs text-zinc-600">{msg.content}</p>
                        )}
                        <img
                          src={msg.imageUrl}
                          alt="Bitbot"
                          className="rounded-xl w-full max-h-[380px] object-cover"
                        />
                      </div>
                    ) : (
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    )}

                    {/* Google Search Grounding Sources (subtle and minimal) */}
                    {msg.sources && msg.sources.length > 0 && (
                      <div className="mt-2.5 pt-2 border-t border-zinc-200/60 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                        <span className="flex items-center gap-1 font-medium">
                          <Globe className="w-3 h-3 text-zinc-400" />
                          <span>מקורות:</span>
                        </span>
                        {msg.sources.map((s, idx) => (
                          <a
                            key={idx}
                            href={s.uri}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-zinc-600 hover:text-black underline underline-offset-2"
                          >
                            <span>{s.title}</span>
                            <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {isLoading && <ThinkingIndicator />}

            <div ref={messagesEndRef} />
          </div>
        )}
      </main>

      {/* Input Area: Minimal, Clean, Centered with no placeholder */}
      <footer className="w-full p-4 border-t border-zinc-100 bg-white sticky bottom-0 z-10 shrink-0">
        <div className="max-w-2xl mx-auto flex items-center bg-zinc-50 border border-zinc-200 focus-within:border-zinc-400 focus-within:bg-white rounded-2xl px-3 py-1.5 transition-all">
          <textarea
            ref={textareaRef}
            rows={1}
            value={inputValue}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder=""
            className="flex-1 max-h-36 min-h-[40px] py-2 px-2 bg-transparent border-0 focus:outline-hidden resize-none text-[15px] placeholder:text-zinc-400 text-zinc-900 leading-normal"
            dir="auto"
          />

          <button
            type="button"
            onClick={handleSend}
            disabled={!inputValue.trim() || isLoading}
            className={`w-8 h-8 flex items-center justify-center rounded-xl transition-all shrink-0 cursor-pointer ${
              inputValue.trim() && !isLoading
                ? 'bg-black text-white hover:bg-zinc-800'
                : 'bg-zinc-200 text-zinc-400 cursor-not-allowed'
            }`}
            title="שלח"
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
      </footer>
    </div>
  );
}
