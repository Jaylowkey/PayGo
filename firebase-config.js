// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, addDoc, getDocs, doc, updateDoc, onSnapshot, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAHxyX5e9O8qQo6Z3VHURgVXhxbxSp0Qh8",
  authDomain: "paygo-14311.firebaseapp.com",
  projectId: "paygo-14311",
  storageBucket: "paygo-14311.firebasestorage.app",
  messagingSenderId: "208360646277",
  appId: "1:208360646277:web:aecc57cc0077ae48a52bec",
  measurementId: "G-N9E391HCFL"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const db = getFirestore(app, "paygodb");
const auth = getAuth(app);

export { db, auth, collection, addDoc, getDocs, doc, updateDoc, onSnapshot, query, orderBy, signInWithEmailAndPassword, signOut, onAuthStateChanged };