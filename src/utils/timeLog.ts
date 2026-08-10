export const timeNow = (query?: string) => {
    console.log(`${query ? `${query}: ` : ""}${new Date().toISOString()}`);
};