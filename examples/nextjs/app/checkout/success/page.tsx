export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const { status } = await searchParams

  return (
    <main className="result">
      <h1>Payment successful</h1>
      <p>Status: {status ?? "success"}</p>
      <p>Thanks for your order — Payweave verified the payment before you saw this page.</p>
    </main>
  )
}
