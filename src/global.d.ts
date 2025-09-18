export {};

declare global {
  namespace NodeJS {
    interface Global {
      schedulerRunning: boolean;
    }
  }
}