import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { useScreen } from "../../../lab/screen-context";
import ProductImage from "./ProductImage";
import LocationIcon from "./icons/Location";

export interface Product {
  title: string;
  image: string;
  tags: string[];
  price: string;
  location: string;
}

const PRODUCTS: Product[] = [
  {
    title: "Sony Playstation 4 500GB",
    image: "playstation.png",
    tags: ["Used", "Negotiable"],
    price: "R 3,089.28",
    location: "Pretoria, South Africa",
  },
  {
    title: "Clarks Men Gessler Shoe",
    image: "shoe.png",
    tags: ["New", "On auction"],
    price: "R 604.05",
    location: "Cape Town, South Africa",
  },
  {
    title: "Nintento Switch Lite Animal Crossing Edition",
    image: "switch.png",
    tags: ["Used", "On auction"],
    price: "R 4,262.86",
    location: "Pretoria, South Africa",
  },
  {
    title: "iPhone 14 Pro 256GB Space Black",
    image: "phone.png",
    tags: ["Used", "Non-negotiable"],
    price: "R 7,490.21",
    location: "Durban, South Africa",
  },
];

export default function Browse() {
  const { visible, active } = useScreen();
  const live = visible && active;
  const [products, setProducts] = useState([...PRODUCTS, ...PRODUCTS]);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (!live) return;

    const interval = setInterval(() => {
      setIsAnimating(true);

      setTimeout(() => {
        setProducts((prev) => {
          const [first, ...rest] = prev;
          return [...rest, first];
        });
        setIsAnimating(false);
      }, 1800);
    }, 2000);

    return () => {
      clearInterval(interval);
    };
  }, [live]);

  return (
    <div className="feature_card">
      <div className="feature_card_content">
        <div className="feature_card_content_image">
          <div className="product-list">
            {products.map((product, index) => (
              <motion.div
                key={`${product.title}-${index}-${product.image}`}
                initial={{ y: 0 }}
                animate={{
                  scale: index === 0 && isAnimating ? 0.97 : 1,
                  y: isAnimating && index > 0 ? -92 : 0,
                  opacity: index === 0 && isAnimating ? 0 : 1,
                }}
                transition={{
                  scale: { duration: 0.3, ease: [0.625, 0.05, 0, 1] },
                  y: { duration: 0.5, delay: 0.5, ease: [0.4, 0, 0.2, 1] },
                  opacity: {
                    duration: 0.3,
                    delay: 0.2,
                    ease: [0.625, 0.05, 0, 1],
                  },
                }}
                className="product-card"
              >
                <BrowseRow product={product} />
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function BrowseRow({ product }: { product: Product }) {
  return (
    <div className="row-container">
      <div className="image-container">
        <ProductImage product={product} />
      </div>

      <div className="content-wrapper">
        <div>
          <p className="product-title">{product.title}</p>

          <div className="tags-container">
            {product.tags.map((tag, index) => (
              <span className="tag" key={tag + index}>
                {tag}
              </span>
            ))}
          </div>
          <div className="location-container">
            <LocationIcon cls="location-icon" />

            <p className="location-text">{product.location}</p>
          </div>
        </div>

        <p className="price">{product.price}</p>
      </div>
    </div>
  );
}
