import { LinqAPIV3 } from "@linqapp/sdk";
import type { AdapterPostableMessage, Attachment, FileUpload } from "chat";

import { isRecord } from "./guards.js";

// Linq downloads `url`-based media on send and caps those at 10MB. Anything
// larger (or not reachable over public HTTPS) has to go through the pre-upload
// flow, which allows up to 100MB.
const URL_DOWNLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

type LinqMediaPart = { type: "media"; url: string } | { type: "media"; attachment_id: string };

type BinaryData = Buffer | Blob | ArrayBuffer | Uint8Array;

// Bytes guaranteed to be backed by a plain ArrayBuffer (not SharedArrayBuffer),
// which is what `fetch` and `Blob` accept as a body.
type UploadBytes = Uint8Array<ArrayBuffer>;

// A subset of Linq's supported types, keyed by file extension. Linq validates
// the real file content on its end; this only needs to be good enough to label
// the pre-upload request. Callers can always pass an explicit mimeType.
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  "3gp": "video/3gpp",
  m4a: "audio/x-m4a",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  wav: "audio/x-wav",
  aiff: "audio/x-aiff",
  caf: "audio/x-caf",
  amr: "audio/amr",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  rtf: "text/rtf",
  vcf: "text/vcard",
  ics: "text/calendar",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// Pull the outbound attachments/files off a postable. Only object-form postables
// (markdown/raw/ast) carry them; strings and cards contribute nothing here.
export function extractOutboundMedia(message: AdapterPostableMessage): {
  attachments: Attachment[];
  files: FileUpload[];
} {
  if (typeof message === "string" || !isRecord(message)) {
    return { attachments: [], files: [] };
  }

  const attachments = Array.isArray(message.attachments)
    ? (message.attachments as Attachment[])
    : [];
  const files = Array.isArray(message.files) ? (message.files as FileUpload[]) : [];

  return { attachments, files };
}

export async function buildLinqMediaParts(
  apiClient: LinqAPIV3,
  message: AdapterPostableMessage,
): Promise<LinqMediaPart[]> {
  const { attachments, files } = extractOutboundMedia(message);

  if (attachments.length === 0 && files.length === 0) {
    return [];
  }

  const parts: LinqMediaPart[] = [];

  for (const attachment of attachments) {
    parts.push(await attachmentToMediaPart(apiClient, attachment));
  }

  for (const file of files) {
    parts.push(await fileToMediaPart(apiClient, file));
  }

  return parts;
}

async function attachmentToMediaPart(
  apiClient: LinqAPIV3,
  attachment: Attachment,
): Promise<LinqMediaPart> {
  // Re-send by reference when Linq can fetch it itself: a public HTTPS URL under
  // the download limit needs no upload round-trip. Inbound Linq media already
  // lives on cdn.linqapp.com, so forwarding it costs nothing.
  if (
    attachment.url &&
    attachment.url.startsWith("https://") &&
    !exceedsUrlDownloadLimit(attachment.size)
  ) {
    return { type: "media", url: attachment.url };
  }

  const bytes = await resolveAttachmentBytes(attachment);
  const filename = attachment.name ?? defaultFilename(attachment.mimeType);
  const contentType = resolveContentType(attachment.mimeType, filename);
  const attachmentId = await uploadBytes(apiClient, bytes, filename, contentType);

  return { type: "media", attachment_id: attachmentId };
}

async function fileToMediaPart(apiClient: LinqAPIV3, file: FileUpload): Promise<LinqMediaPart> {
  const bytes = await toBytes(file.data);
  const contentType = resolveContentType(file.mimeType, file.filename);
  const attachmentId = await uploadBytes(apiClient, bytes, file.filename, contentType);

  return { type: "media", attachment_id: attachmentId };
}

async function uploadBytes(
  apiClient: LinqAPIV3,
  bytes: UploadBytes,
  filename: string,
  contentType: string,
): Promise<string> {
  const created = await apiClient.attachments.create({
    filename,
    content_type: contentType as LinqAPIV3.SupportedContentType,
    size_bytes: bytes.byteLength,
  });

  const upload = await fetch(created.upload_url, {
    method: created.http_method,
    headers: created.required_headers,
    body: bytes,
  });

  if (!upload.ok) {
    throw new Error(
      `Failed to upload Linq attachment ${filename}: ${upload.status} ${upload.statusText}`,
    );
  }

  return created.attachment_id;
}

async function resolveAttachmentBytes(attachment: Attachment): Promise<UploadBytes> {
  if (attachment.data != null) {
    return toBytes(attachment.data);
  }

  if (typeof attachment.fetchData === "function") {
    return toBytes(await attachment.fetchData());
  }

  if (attachment.url) {
    const response = await fetch(attachment.url);

    if (!response.ok) {
      throw new Error(
        `Failed to download Linq attachment ${attachment.name ?? attachment.url}: ${response.status}`,
      );
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  throw new Error(
    `Outbound attachment ${attachment.name ?? "(unnamed)"} has no data, fetchData, or url to send`,
  );
}

// Copy into a fresh ArrayBuffer-backed view. The copy also detaches us from any
// SharedArrayBuffer backing, which `fetch` bodies reject.
async function toBytes(data: BinaryData): Promise<UploadBytes> {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data);
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }

  throw new Error("Unsupported attachment data type; expected Buffer, Blob, or ArrayBuffer");
}

function exceedsUrlDownloadLimit(size: number | undefined): boolean {
  return typeof size === "number" && size > URL_DOWNLOAD_LIMIT_BYTES;
}

function resolveContentType(mimeType: string | undefined, filename: string): string {
  if (mimeType && mimeType.trim()) {
    return normalizeMimeType(mimeType.trim());
  }

  const extension = filename.split(".").pop()?.toLowerCase();
  const inferred = extension ? EXTENSION_CONTENT_TYPES[extension] : undefined;

  if (inferred) {
    return inferred;
  }

  throw new Error(
    `Cannot determine content type for attachment "${filename}"; set mimeType on the attachment`,
  );
}

function normalizeMimeType(mimeType: string): string {
  const lower = mimeType.toLowerCase();

  if (lower === "image/jpg") {
    return "image/jpeg";
  }

  return lower;
}

function defaultFilename(mimeType: string | undefined): string {
  const extension = mimeType ? extensionForMimeType(mimeType) : undefined;

  return extension ? `attachment.${extension}` : "attachment";
}

function extensionForMimeType(mimeType: string): string | undefined {
  const normalized = normalizeMimeType(mimeType);

  for (const [extension, candidate] of Object.entries(EXTENSION_CONTENT_TYPES)) {
    if (candidate === normalized) {
      return extension;
    }
  }

  return undefined;
}
