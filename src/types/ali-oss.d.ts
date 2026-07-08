declare module "ali-oss" {
  export interface OSSOptions {
    region?: string;
    bucket?: string;
    endpoint?: string;
    accessKeyId?: string;
    accessKeySecret?: string;
    stsToken?: string;
    refreshSTSToken?: () => Promise<{
      accessKeyId: string;
      accessKeySecret: string;
      stsToken: string;
    }>;
    refreshSTSTokenInterval?: number;
    [key: string]: any;
  }

  export interface PutResult {
    name: string;
    url: string;
    res: any;
  }

  export default class OSS {
    constructor(options: OSSOptions);
    put(name: string, file: any, options?: any): Promise<PutResult>;
    signatureUrl(name: string, options?: any): string;
    [key: string]: any;
  }
}
