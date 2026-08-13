const GENUS_A = ['Chlor', 'Sarco', 'Necro', 'Hydro', 'Photo', 'Myco', 'Vir', 'Zo', 'Sango', 'Cera', 'Xantho', 'Melano'];
const GENUS_B = ['aster', 'phyta', 'zoon', 'morpha', 'plasma', 'derma', 'soma', 'cystis'];
const SPECIES_WORD = ['ella', 'osa', 'iensis', 'formis', 'arius', 'oides', 'ana', 'ica', 'alis', 'inus'];
function hashSequence(sequence) {
    let h = 2166136261;
    for (const gene of sequence.genes) {
        for (const symbol of gene) {
            h ^= symbol.charCodeAt(0);
            h = Math.imul(h, 16777619);
        }
    }
    return h >>> 0;
}
export function generateSpeciesName(sequence) {
    const h = hashSequence(sequence);
    const a = GENUS_A[h % GENUS_A.length];
    const b = GENUS_B[Math.floor(h / GENUS_A.length) % GENUS_B.length];
    const species = SPECIES_WORD[Math.floor(h / (GENUS_A.length * GENUS_B.length)) % SPECIES_WORD.length];
    return `${a}${b} ${species}`;
}
