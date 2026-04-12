declare module "node-gtts" {
  import { Readable } from "stream";
  interface GTTS {
    stream(text: string): Readable;
    save(filepath: string, text: string, callback: (err?: Error) => void): void;
  }
  function gtts(lang: string): GTTS;
  export = gtts;
}
