import { gc } from "./cleanup.js";

/** Periodic job: for now just runs gc(). */
export const janitor = () => gc();
