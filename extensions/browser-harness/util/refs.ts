// Process-wide allocation prevents a reference from resolving in another tab or connection.
let nextRef = 1;
export const allocateRef = (): string => `e${nextRef++}`;
