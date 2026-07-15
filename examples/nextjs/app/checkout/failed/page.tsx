export default async function CheckoutFailedPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const { status } = await searchParams

  return (
    <main className="result">
      <h1>Payment not completed</h1>
      <p>Status: {status ?? "failed"}</p>
      <p>No charge was made. You can close this tab or try again.</p>
    </main>
  )
}
