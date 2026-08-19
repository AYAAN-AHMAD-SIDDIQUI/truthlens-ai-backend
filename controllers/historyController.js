const prisma = require("../config/prisma");

// Get all history
const getHistory = async (req, res) => {
  try {
    const history = await prisma.analysis.findMany({
      where: {
        userId: req.user.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.status(200).json({
      success: true,
      history,
    });
  } catch (err) {
    console.log(err);

    res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

// Get single history
const getSingleHistory = async (req, res) => {
  try {
const id = Number(req.params.id);
    const analysis = await prisma.analysis.findFirst({
      where: {
        id,
        userId: req.user.id,
      },
    });

    if (!analysis) {
      return res.status(404).json({
        success: false,
        message: "Analysis not found",
      });
    }

    res.status(200).json({
      success: true,
      analysis,
    });
  } catch (err) {
    console.log(err);

    res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

// Delete history
const deleteHistory = async (req, res) => {
  try {
    const id = Number(req.params.id);

    const analysis = await prisma.analysis.findFirst({
      where: {
        id,
        userId: req.user.id,
      },
    });

    if (!analysis) {
      return res.status(404).json({
        success: false,
        message: "Analysis not found",
      });
    }

    await prisma.analysis.delete({
      where: {
        id,
      },
    });

    return res.status(200).json({
      success: true,
      message: "History deleted successfully",
    });
  } catch (err) {
    console.error("Delete Error:", err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};
  


module.exports = {
  getHistory,
  getSingleHistory,
  deleteHistory,
};