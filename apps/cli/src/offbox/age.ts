import {
	identityToRecipient as ageIdentityToRecipient,
	Decrypter,
	Encrypter,
	generateIdentity as generateAgeIdentity,
} from "age-encryption";
import { PackbatError } from "../core/errors.js";

export async function generateIdentity(): Promise<string> {
	return await generateAgeIdentity();
}

export async function identityToRecipient(identity: string): Promise<string> {
	return await ageIdentityToRecipient(identity);
}

export async function encryptToRecipient(recipient: string, plaintext: Uint8Array): Promise<Buffer> {
	const encrypter = new Encrypter();
	encrypter.addRecipient(recipient);
	return Buffer.from(await encrypter.encrypt(plaintext));
}

export async function decryptWithIdentity(identity: string, ciphertext: Uint8Array): Promise<Buffer> {
	const decrypter = new Decrypter();
	decrypter.addIdentity(identity);
	return Buffer.from(await decrypter.decrypt(ciphertext));
}

export function parseIdentityFile(contents: string): string {
	const identity = contents
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.find((line) => /^AGE-SECRET-KEY-1[0-9A-Z]+$/u.test(line));
	if (identity === undefined) {
		throw new PackbatError("identity file does not contain an AGE-SECRET-KEY-1… identity");
	}
	return identity;
}
