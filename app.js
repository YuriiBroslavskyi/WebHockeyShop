const express = require('express');
const bodyParser = require('body-parser');
const mysql = require('mysql2');
const ejs = require('ejs');
require("dotenv").config()
const app = express();
const PORT = process.env.PORT || 3000;
const bcrypt = require('bcrypt');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');

app.set('view engine', 'ejs');
app.use('/public', express.static(path.join(__dirname, 'public')));

// Database connection
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

db.connect((err) => {
    if (err) {
        console.error('Error connecting to MySQL:', err);
    } else {
        console.log('Connected to MySQL database');
    }
});

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(cookieParser());
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false },
}));
app.set('view engine', 'ejs');

// Render the login page by default
app.get('/', (req, res) => {
    // Fetch necessary data for the index page from the database
    const query = 'SELECT * FROM hockey_equipment';

    db.query(query, (err, results) => {
        if (err) {
            console.error('Error querying equipment data from the database:', err);
            return res.status(500).send('Internal Server Error');
        }

        const equipment = results;
        const user = req.session.user; // Retrieve user information from the session

        res.render('index', { equipment, user });
    });
});

app.get('/login', (req, res) => {
    res.render('login', { error: undefined });
});

app.get('/logout', (req, res) => {
    // Clear the user session
    req.session.destroy(err => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.status(500).send('Internal Server Error');
        }

        // Redirect to the home page after logout
        res.redirect('/');
    });
});

// Render the sign-up page
app.get('/signup', (req, res) => {
    res.render('signup', { error: undefined });
});

app.get('/profile', (req, res) => {
    const userId = req.session.user ? req.session.user.id : null;

    // Fetch user data and their order history from the database
    getUserDataAndOrders(userId, (err, userData) => {
        if (err) {
            return res.status(500).send('Internal Server Error');
        }

        res.render('profile', { user: userData, error: null });
    });
});

app.get('/change-password', (req, res) => {
    // Check if the user is logged in
    if (req.session.user) {
        const userEmail = req.session.user.email;
        res.render('change_password', { userEmail });
    } else {
        // Redirect to the login page if the user is not logged in
        res.redirect('/login');
    }
});


app.post('/change-password', (req, res) => {
    const userId = req.session.user ? req.session.user.id : null;
    const currentPassword = req.body.currentPassword;
    const newPassword = req.body.newPassword;
    const confirmPassword = req.body.confirmPassword;
    const userEmail = req.session.user.email ? req.session.user.email : null;

    // Check if the user is logged in
    if (!userEmail) {
        return res.status(401).render('change_password', { user: null, error: 'You are not logged in.' });
    }

    // Validate the input
    if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).render('change_password', { user: req.session.user, error: 'All fields are required.' });
    }

    // Retrieve user data from the database
    getUserDataById(userId, (getUserErr, user) => {
        if (getUserErr) {
            return res.status(500).render('change_password', { user: req.session.user, error: 'Internal Server Error' });
        }

        // Validate the current password
        validatePassword(currentPassword, user.password_hash, user.password_salt, (validateErr, passwordMatch) => {
            if (validateErr) {
                return res.status(500).render('change_password', { user: req.session.user, error: 'Internal Server Error' });
            }

            if (!passwordMatch) {
                return res.render('change_password', { user: req.session.user, error: 'Current password is incorrect.' });
            }

            // Validate the new password
            if (newPassword !== confirmPassword) {
                return res.render('change_password', { user: req.session.user, error: 'New passwords do not match.' });
            }

            // Hash the new password
            hashPassword(newPassword, (hashErr, hashedPassword, salt) => {
                if (hashErr) {
                    return res.status(500).render('change_password', { user: req.session.user, error: 'Internal Server Error' });
                }

                // Update the user's password in the database
                updateUserPassword(userId, hashedPassword, salt, (updateErr) => {
                    if (updateErr) {
                        return res.status(500).render('change_password', { user: req.session.user, error: 'Internal Server Error' });
                    }

                    // Redirect to the profile page or home after successful password change
                    res.redirect('/profile');
                });
            });
        });
    });
});

// Handle login form submission
app.post('/login', (req, res) => {
    const { emailOrPhone, password } = req.body;

    // Query the database to check if the user exists
    getUserDataByEmail(emailOrPhone, (err, user) => {
        if (err) {
            return res.status(500).render('login', { error: 'Internal Server Error' });
        }

        // Check if the user exists
        if (!user) {
            return res.render('login', { error: 'Invalid email or phone number' });
        }

        // Validate the password using bcrypt
        validatePassword(password, user.password_hash, user.password_salt, (bcryptErr, passwordMatch) => {
            if (bcryptErr) {
                console.error('Error comparing passwords:', bcryptErr);
                return res.status(500).render('login', { error: 'Internal Server Error' });
            }

            if (passwordMatch) {
                // Password is correct; set up session and redirect to the main page
                req.session.user = {
                    id: user.id,
                    email: user.user_email,
                };

                res.redirect('/');
            } else {
                // Password is incorrect
                res.render('login', { error: 'Invalid password' });
            }
        });
    });
});

// Handle sign-up form submission
app.post('/signup', (req, res) => {
    const { email, password, confirmPassword } = req.body;

    // Validate the input
    if (!email || !password || !confirmPassword || password !== confirmPassword) {
        return res.render('signup', { error: 'Invalid input or passwords do not match' });
    }

    // Check if the user already exists in the database
    getUserDataByEmail(email, (err, existingUser) => {
        if (err) {
            return res.status(500).render('signup', { error: 'Internal Server Error' });
        }

        if (existingUser) {
            return res.render('signup', { error: 'User with this email already exists' });
        }

        // Hash the password and save the user to the database
        hashPassword(password, (hashErr, hashedPassword, salt) => {
            if (hashErr) {
                console.error('Error hashing password:', hashErr);
                return res.status(500).render('signup', { error: 'Internal Server Error' });
            }

            // Insert the new user into the database
            const insertQuery = 'INSERT INTO user_info (user_email, password_hash, password_salt) VALUES (?, ?, ?)';
            db.query(insertQuery, [email, hashedPassword, salt], (insertErr) => {
                if (insertErr) {
                    console.error('Error inserting user into the database:', insertErr);
                    return res.status(500).render('signup', { error: 'Internal Server Error' });
                }

                // User successfully created; redirect to login
                res.redirect('/login');
            });
        });
    });
});

// Handle form submission for adding items to the cart
app.post('/add-to-cart', (req, res) => {
    const userId = req.body.userId;
    const itemId = req.body.itemId;
    const quantity = req.body.quantity;
    const size = req.body.size;

    // Check if the quantity is a valid integer
    if (!Number.isInteger(parseInt(quantity, 10)) || parseInt(quantity, 10) <= 0) {
        const error = 'Invalid quantity. Please enter a valid positive integer.';
        return res.render('cart', { cart: null, error });
    }

    // Fetch item details including the image and sizes based on itemId
    getEquipmentItemData(itemId, (err, item) => {
        if (err) {
            const error = 'Internal Server Error';
            return res.render('cart', { cart: null, error });
        }

        if (!item) {
            const error = 'Item not found';
            return res.render('cart', { cart: null, error });
        }

        // Retrieve or create the user's shopping cart
        getOrCreateShoppingCart(userId, (cartErr, cart) => {
            if (cartErr) {
                const error = 'Internal Server Error';
                return res.render('cart', { cart: null, error });
            }

            // Add the item to the cart
            const updatedCart = addToCart(cart, item, parseInt(quantity, 10), size);

            // Update the shopping cart in the database
            updateShoppingCart(userId, updatedCart, (updateErr) => {
                if (updateErr) {
                    const error = 'Internal Server Error';
                    return res.render('cart', { cart: null, error });
                }

                // Redirect to the cart view
                res.redirect('/cart');
            });
        });
    });
});

// View shopping cart
app.get('/cart', (req, res) => {
    const userId = req.session.user ? req.session.user.id : null;

    // Retrieve or create the user's shopping cart
    getOrCreateShoppingCart(userId, (err, cart) => {
        if (err) {
            return res.status(500).send('Internal Server Error');
        }

        // Parse cart_items if it's a JSON string
        if (cart && cart.cart_items && typeof cart.cart_items === 'string') {
            cart.cart_items = JSON.parse(cart.cart_items);
        }

        // Fetch details for each item in the cart, including the image
        const itemPromises = cart.cart_items.map(cartItem => {
            return new Promise((resolve, reject) => {
                getEquipmentItemData(cartItem.id, (itemErr, item) => {
                    if (itemErr) {
                        reject(itemErr);
                    } else {
                        resolve({ ...cartItem, image: item.image });
                    }
                });
            });
        });

        // Resolve all promises and render the cart view with item details
        Promise.all(itemPromises)
            .then(itemsWithImages => {
                res.render('cart', { cart, itemsWithImages, error: null });
            })
            .catch(error => {
                res.status(500).send('Internal Server Error');
            });
    });
});

// Complete purchase
app.post('/complete-purchase', (req, res) => {
    const userId = req.session.user ? req.session.user.id : null;

    // Retrieve or create the user's shopping cart
    getOrCreateShoppingCart(userId, (cartErr, cart) => {
        if (cartErr) {
            return res.status(500).send('Internal Server Error');
        }

        // Calculate the total sum of the items in the cart
        const totalSumInCents = calculateTotal(cart.cart_items);

        // Prepare the order data
        const orderData = {
            user_id: userId,
            ordered_items: JSON.stringify(cart.cart_items), // Convert items to JSON string
            order_status: 'Completed',
            total_sum_in_cents: totalSumInCents,
            payment_method: req.body.paymentMethod,
            transaction_id: req.body.transactionId,
        };

        // Save the order data to the database
        saveOrderToDatabase(orderData, (saveOrderErr) => {
            if (saveOrderErr) {
                return res.status(500).send('Internal Server Error');
            }

            // Clear the user's shopping cart after completing the purchase
            clearShoppingCart(userId, (clearErr) => {
                if (clearErr) {
                    return res.status(500).send('Internal Server Error');
                }

                res.redirect('/'); // Redirect to the main page after completing the purchase
            });
        });
    });
});


app.post('/clear-cart', (req, res) => {
    const userId = req.session.user ? req.session.user.id : null;

    // Clear the user's shopping cart in the database
    clearShoppingCart(userId, (clearErr) => {
        if (clearErr) {
            return res.status(500).send('Internal Server Error');
        }

        // Redirect to the cart page after clearing the cart
        res.redirect('/cart');
    });
});

// Handle requests to display details for a specific item
app.get('/item/:id', (req, res) => {
    const itemId = req.params.id;
    // Fetch data for the specific item using the itemId
    getEquipmentItemData(itemId, (err, item) => {
        if (err) {
            return res.status(500).send('Internal Server Error');
        }

        if (item) {
            res.render('item_details', { item, user: req.session.user });
        } else {
            res.status(404).send('Item not found');
        }
    });
});

// Helper function to hash a password using bcrypt with salt
function hashPassword(password, callback) {
    bcrypt.genSalt(10, (err, salt) => {
        if (err) {
            return callback(err, null);
        }
        bcrypt.hash(password, salt, (hashErr, hash) => {
            callback(hashErr, hash, salt);
        });
    });
}

// Helper function to validate a password using bcrypt with salt
function validatePassword(inputPassword, storedHash, salt, callback) {
    bcrypt.hash(inputPassword, salt, (err, hashedPassword) => {
        if (err) {
            return callback(err, null);
        }
        callback(null, hashedPassword === storedHash);
    });
}

// Helper function to get data for a specific equipment item by ID from the database
function getEquipmentItemData(itemId, callback) {
    const query = 'SELECT * FROM hockey_equipment WHERE id = ?';

    db.query(query, [itemId], (err, results) => {
        if (err) {
            console.error('Error querying equipment item data from the database:', err);
            callback(err, null);
        } else {
            const item = results[0];
            if (item && item.sizes) {
                // Parse the sizes string into an array of size objects
                item.sizes = JSON.parse(item.sizes);
            }
            callback(null, item);
        }
    });
}


function getUserDataByEmail(email, callback) {
    const query = 'SELECT * FROM user_info WHERE user_email = ?';

    db.query(query, [email], (err, results) => {
        if (err) {
            console.error('Error querying the database:', err);
            callback(err, null);
        } else {
            const user = results[0];
            callback(null, user);
        }
    });
}

// Helper function to retrieve or create the user's shopping cart
function getOrCreateShoppingCart(userId, callback) {
    const selectQuery = 'SELECT * FROM shopping_carts WHERE user_id = ? AND order_status = ?';
    const insertQuery = 'INSERT INTO shopping_carts (user_id, cart_items, order_status) VALUES (?, ?, ?)';

    db.query(selectQuery, [userId, 'In Progress'], (selectErr, result) => {
        if (selectErr) {
            return callback(selectErr, null);
        }

        if (result.length > 0) {
            // User's cart already exists, parse cart_items before returning
            const existingCart = result[0];
            existingCart.cart_items = JSON.parse(existingCart.cart_items);
            callback(null, existingCart);
        } else {
            // Create a new cart for the user
            const newCart = {
                user_id: userId,
                cart_items: [],
                order_status: 'In Progress',
            };

            db.query(insertQuery, [userId, JSON.stringify(newCart.cart_items), newCart.order_status], (insertErr, insertResult) => {
                if (insertErr) {
                    return callback(insertErr, null);
                }

                newCart.id = insertResult.insertId;
                callback(null, newCart);
            });
        }
    });
}

// Helper function to add an item to the shopping cart
function addToCart(cart, item, quantity, size) {
    const existingItemIndex = cart.cart_items.findIndex(cartItem => cartItem.id === item.id && cartItem.size === size);

    if (existingItemIndex !== -1) {
        // Item with the same ID and size already exists in the cart, update quantity
        cart.cart_items[existingItemIndex].quantity += quantity;
    } else {
        // Add a new item to the cart
        const newItem = {
            id: item.id,
            name: item.name,
            description: item.description,
            price_in_cents: item.price_in_cents,
            image: item.image,
            quantity: parseInt(quantity, 10), // Parse quantity to ensure it's an integer
            size
        };

        cart.cart_items.push(newItem);
    }

    return cart;
}

// Helper function to update the shopping cart in the database
function updateShoppingCart(userId, cart, callback) {
    const updateQuery = 'UPDATE shopping_carts SET cart_items = ? WHERE user_id = ? AND order_status = ?';

    db.query(updateQuery, [JSON.stringify(cart.cart_items), userId, 'In Progress'], (updateErr) => {
        if (updateErr) {
            return callback(updateErr);
        }

        callback(null);
    });
}

// Helper function to update the order status in the database
function updateOrderStatus(userId, cartId, orderStatus, callback) {
    const updateQuery = 'UPDATE shopping_carts SET order_status = ? WHERE user_id = ? AND id = ?';

    db.query(updateQuery, [orderStatus, userId, cartId], (updateErr) => {
        if (updateErr) {
            return callback(updateErr);
        }

        callback(null);
    });
}

// Helper function to clear the user's shopping cart
function clearShoppingCart(userId, callback) {
    const deleteQuery = 'DELETE FROM shopping_carts WHERE user_id = ? AND order_status = ?';

    db.query(deleteQuery, [userId, 'In Progress'], (deleteErr) => {
        if (deleteErr) {
            return callback(deleteErr);
        }

        callback(null);
    });
}

// Helper function to fetch user data and order history
function getUserDataAndOrders(userId, callback) {
    const userQuery = 'SELECT * FROM user_info WHERE id = ?';
    const ordersQuery = 'SELECT * FROM user_orders WHERE user_id = ?';

    db.query(userQuery, [userId], (userErr, userResult) => {
        if (userErr) {
            return callback(userErr, null);
        }

        const user = userResult[0];

        // If the user exists, fetch their order history
        if (user) {
            db.query(ordersQuery, [userId], (ordersErr, ordersResult) => {
                if (ordersErr) {
                    return callback(ordersErr, null);
                }

                const userWithOrders = { ...user, orders: ordersResult };
                callback(null, userWithOrders);
            });
        } else {
            callback(null, null);
        }
    });
}

// Helper function to retrieve user data by ID from the database
function getUserDataById(userId, callback) {
    const query = 'SELECT * FROM user_info WHERE id = ?';

    db.query(query, [userId], (err, results) => {
        if (err) {
            console.error('Error querying user data from the database:', err);
            callback(err, null);
        } else {
            const user = results[0];
            callback(null, user);
        }
    });
}

// Helper function to update the user's password in the database
function updateUserPassword(userId, hashedPassword, salt, callback) {
    const updateQuery = 'UPDATE user_info SET password_hash = ?, password_salt = ? WHERE id = ?';

    db.query(updateQuery, [hashedPassword, salt, userId], (updateErr) => {
        if (updateErr) {
            callback(updateErr);
        } else {
            callback(null);
        }
    });
}

// Function to calculate the total sum of items in the cart
function calculateTotal(cartItems) {
    return cartItems.reduce((total, item) => {
        return total + item.quantity * item.price_in_cents;
    }, 0);
}

// Function to save order data to the database
function saveOrderToDatabase(orderData, callback) {
    const sql = 'INSERT INTO user_orders (user_id, ordered_items, order_status, total_sum_in_cents, payment_method, transaction_id) VALUES (?, ?, ?, ?, ?, ?)';

    // Extract values from orderData
    const values = [
        orderData.user_id,
        orderData.ordered_items,
        orderData.order_status,
        orderData.total_sum_in_cents,
        orderData.payment_method,
        orderData.transaction_id
    ];

    // Execute the SQL query
    db.query(sql, values, (err, result) => {
        if (err) {
            return callback(err);
        }

        // If the insertion was successful, invoke the callback with no error
        callback(null);
    });
}

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});