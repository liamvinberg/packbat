import { createFileRoute } from "@tanstack/react-router";
import { CheckoutResult } from "../../../components/checkout-result";

export const Route = createFileRoute("/cloud/checkout/success")({
	component: CheckoutSuccessPage,
	head: () => ({ meta: [{ title: "Packbat Cloud payment complete" }] }),
});

function CheckoutSuccessPage() {
	return (
		<CheckoutResult
			action={
				<a
					className="inline-flex rounded-sm bg-accent px-[18px] py-[11px] font-display text-sm leading-ui font-bold text-ground"
					href="/docs"
				>
					Open the docs
				</a>
			}
			detail="Return to the terminal. Packbat will continue automatically as soon as Stripe confirms your subscription."
			status="Stripe is confirming your subscription."
			title="Payment complete."
		/>
	);
}
