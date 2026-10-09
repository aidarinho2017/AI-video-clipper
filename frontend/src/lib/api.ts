export const API = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/$/, "");

const SESSION = "clipper-session";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

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
    throw new ApiError("Cannot reach the backend. Check the server connection and try again.", 0);
  }
  const data = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    if (response.status === 401 && token) clearSession();
    throw new ApiError(typeof data?.detail === "string" ? data.detail : "Request failed. Try again.", response.status);
  }
  if (response.status !== 204 && data === undefined) throw new ApiError("The server returned an invalid response. Try again.", response.status);
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

export function uploadRequest<T>(path: string, file: File, onProgress: (percent: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${API}${path}`);
    request.withCredentials = true;
    const token = localStorage.getItem(SESSION);
    if (token) request.setRequestHeader("Authorization", `Bearer ${token}`);
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    };
    request.onerror = () => reject(new Error("Upload interrupted. Check your connection and try again."));
    request.onabort = () => reject(new Error("Upload cancelled."));
    request.onload = () => {
      if (request.status === 401 && token) clearSession();
      try {
        const data = JSON.parse(request.responseText);
        if (request.status >= 200 && request.status < 300) resolve(data);
        else reject(new Error(typeof data?.detail === "string" ? data.detail : "Upload failed. Try again."));
      } catch {
        reject(new Error("Upload failed. The server returned an invalid response."));
      }
    };
    request.send(file);
  });
}
