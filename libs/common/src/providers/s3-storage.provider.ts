import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl as getS3SignedUrl } from '@aws-sdk/s3-request-presigner';
import { FileStorageProvider, StorageUploadResult } from '../interfaces/file-storage-provider.interface';

export interface S3ConfigOptions {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  endpoint?: string;
}

@Injectable()
export class S3StorageProvider implements FileStorageProvider {
  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(options: S3ConfigOptions) {
    this.bucketName = options.bucket;
    this.s3Client = new S3Client({
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      endpoint: options.endpoint || undefined,
      forcePathStyle: !!options.endpoint,
    });
  }

  async uploadFile(
    fileBuffer: Buffer,
    key: string,
    mimeType: string,
    options?: { isPublic?: boolean },
  ): Promise<StorageUploadResult> {
    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: fileBuffer,
          ContentType: mimeType,
          ACL: options?.isPublic ? 'public-read' : 'private',
        }),
      );

      this.logger.log(`File uploaded to S3 bucket ${this.bucketName}: ${key}`);

      return {
        storageKey: key,
        storageProvider: 's3',
        mimeType,
        size: fileBuffer.length,
      };
    } catch (error: any) {
      this.logger.error(`S3 upload error for key ${key}: ${error.message}`);
      throw new BadRequestException(`S3 Storage upload failed: ${error.message}`);
    }
  }

  async downloadFile(key: string): Promise<Buffer> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      const response = await this.s3Client.send(command);
      const stream = response.Body as any;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (error: any) {
      this.logger.error(`S3 download error for key ${key}: ${error.message}`);
      throw new NotFoundException(`File not found in S3 storage: ${key}`);
    }
  }

  async deleteFile(key: string): Promise<boolean> {
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        }),
      );
      return true;
    } catch (error: any) {
      this.logger.error(`S3 delete error for key ${key}: ${error.message}`);
      return false;
    }
  }

  async fileExists(key: string): Promise<boolean> {
    try {
      await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });
    return getS3SignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
  }
}
