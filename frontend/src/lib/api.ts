export const API = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/$/, "");

const SESSION = "clipper-session";

export function saveSession(token: string) {
  localStorage.setItem(SESSION, token);
}

export function clearSession() {
  localStorage.removeItem(SESSION);
}

export async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  const token = localStorage.getItem(SESSION);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...options,
      headers,
      credentials: "include",
      signal: options?.signal ?? (options?.body instanceof Blob ? undefined : AbortSignal.timeout(15000)),
    });
  } catch {
    throw new Error("Cannot reach the backend. Check the server connection and try again.");
  }
  const data = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    if (response.status === 401 && token) clearSession();
    throw new Error(typeof data?.detail === "string" ? data.detail : "Request failed. Try again.");
  }
  return data as T;
}

export async function mediaUrl(path: string): Promise<string> {
  const result = await apiRequest<{ token: string }>("/auth/media-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  return `${API}${path}?media_token=${encodeURIComponent(result.token)}`;
}
