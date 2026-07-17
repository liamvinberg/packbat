import { identityToRecipient as ageIdentityToRecipient, generateIdentity as generateAgeIdentity } from "age-encryption";

export async function generateTestIdentity(): Promise<{ identity: string; recipient: string }> {
	const identity = await generateAgeIdentity();
	return { identity, recipient: await ageIdentityToRecipient(identity) };
}
