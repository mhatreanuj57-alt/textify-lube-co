import styles from './Spinner.module.css';

export default function Spinner({ fullscreen = false, label = 'Loading...' }) {
  return (
    <div className={`${styles.wrapper} ${fullscreen ? styles.fullscreen : ''}`}>
      <span className={styles.spinner} aria-hidden="true" />
      <span className="sr-only">{label}</span>
      <p className={styles.label}>{label}</p>
    </div>
  );
}
