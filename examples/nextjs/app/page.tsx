export default function HomePage() {
  return (
    <main>
      <h1>Payweave + Stripe demo checkout</h1>
      <p>
        This minimal example creates a Payweave checkout session backed by Stripe for a fixed
        $20.00 demo charge, then redirects you there to pay.
      </p>
      <form action="/api/checkout" method="POST">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" placeholder="ada@example.com" required />
        <button type="submit">Pay $20.00</button>
      </form>
    </main>
  )
}
