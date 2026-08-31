import type { Product } from "./Browse";

export default function ProductImage({ product }: { product: Product }) {
  return (
    <div
      className="product-image"
      style={{
        backgroundImage: `url(/images/products/${product.image})`,
        backgroundSize: "contain",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "center",
        width: "100%",
        height: "auto",
      }}
    />
  );
}
