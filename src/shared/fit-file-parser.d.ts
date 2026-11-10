declare module 'fit-file-parser' {
  export default class FitParser {
    constructor(options?: {
      force?: boolean;
      speedUnit?: 'm/s' | 'km/h' | 'mph';
      lengthUnit?: 'm' | 'km' | 'mi';
      temperatureUnit?: 'celsius' | 'kelvin' | 'fahrenheit';
      elapsedRecordField?: boolean;
      mode?: 'list' | 'hierarchy' | 'both';
    });
    parse(
      content: ArrayBuffer | Buffer,
      callback: (error: string | null, data: any) => void
    ): void;
  }
}

