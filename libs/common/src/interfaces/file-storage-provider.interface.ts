export interface StorageUploadResult {
  storageKey: string;
  storageProvider: 's3' | 'local';
  mimeType: string;
  size: number;
}

export interface FileStorageProvider {
  uploadFile(
    fileBuffer: Buffer,
    key: string,
    mimeType: string,
    options?: { isPublic?: boolean },
  ): Promise<StorageUploadResult>;

  downloadFile(key: string): Promise<Buffer>;

  deleteFile(key: string): Promise<boolean>;

  fileExists(key: string): Promise<boolean>;

  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
}
