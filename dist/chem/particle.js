import { foldPeptide, foldRna } from './polymer.js';
export function refoldPeptide(p) {
    p.fold = foldPeptide(p.sequence);
}
export function refoldRna(p) {
    p.fold = foldRna(p.sequence);
}
